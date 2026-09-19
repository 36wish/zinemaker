/* Test plumbing: assertions, and a headless-Chrome driver over the DevTools
   protocol. No dependencies — Node 18+ has fetch and WebSocket built in, which
   keeps the test suite under the same rule as the app itself. */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------------------------------------------------------- assertions */

class Failure extends Error {}

function fail(msg) { throw new Failure(msg); }

const show = v => {
  const s = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
};

const assert = {
  ok(cond, msg) { if (!cond) fail(msg || 'expected a truthy value'); },
  eq(got, want, msg) {
    if (got !== want) fail((msg ? msg + ': ' : '') + 'got ' + show(got) + ', want ' + show(want));
  },
  near(got, want, tol, msg) {
    if (!(Math.abs(got - want) <= tol)) {
      fail((msg ? msg + ': ' : '') + 'got ' + got + ', want ' + want + ' +/- ' + tol);
    }
  },
  includes(hay, needle, msg) {
    if (String(hay).indexOf(needle) < 0) {
      fail((msg ? msg + ': ' : '') + show(hay) + ' does not contain ' + show(needle));
    }
  },
  deepEq(got, want, msg) {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a !== b) fail((msg ? msg + ': ' : '') + 'got ' + show(a) + ', want ' + show(b));
  }
};

/* ---------------------------------------------------------------- browser */

const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
];

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('No Chrome found. Set the CHROME environment variable to its path.');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* The app is one classic script, so every top-level function and binding is
   reachable from Runtime.evaluate. That is the whole testing strategy: drive
   the real code in a real browser and measure what it actually renders. */
async function openApp(url) {
  const appUrl = url ||
    'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
  const port = 9500 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zine-test-'));
  const chrome = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--window-size=1400,900',
    appUrl
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      target = list.find(t => t.type === 'page' && t.url !== 'about:blank');
    } catch (err) { /* not listening yet */ }
    if (!target) await sleep(250);
  }
  if (!target) { chrome.kill(); throw new Error('Chrome did not start'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const requests = [];
  let loadWaiters = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map(a => a.value || a.description).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleErrors.push('uncaught: ' + ((d.exception && d.exception.description) || d.text));
    }
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
    if (m.method === 'Page.loadEventFired') { loadWaiters.forEach(r => r()); loadWaiters = []; }
  };
  const send = (method, params) => new Promise(res => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method: method, params: params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');

  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true
    });
    const d = r.result.exceptionDetails;
    if (d) throw new Failure('in page: ' + ((d.exception && d.exception.description) || d.text));
    return r.result.result.value;
  };

  for (let i = 0; i < 60; i++) {
    const ready = await evaluate(
      "document.readyState === 'complete' && typeof paintAll === 'function' && typeof QR !== 'undefined'");
    if (ready) break;
    await sleep(200);
  }

  return {
    url: appUrl,
    evaluate: evaluate,
    consoleErrors: consoleErrors,
    requests: requests,
    /* Put the app back to a known state so tests do not depend on each other. */
    async reset(over) {
      await evaluate(`(() => {
        try { localStorage.clear(); } catch (e) {}
        window.confirm = () => true;
        state.paper = 'a4'; state.margin = 5;
        state.cut = true; state.guides = false; state.trimMargin = false;
        state.title = 'test zine'; state.active = 0;
        state.docs = { mini: blankDoc(8) };
        selId = null; editingId = null;
        hist.length = 0; future.length = 0;
        Object.assign(state, ${JSON.stringify(over || {})});
        if (helpOpen) setHelp(false);
        paintAll();
        return true;
      })()`);
    },
    /* Loads the page again with recording already running, so the request log
       and the console cover the load itself rather than starting after it. */
    async reload() {
      requests.length = 0;
      consoleErrors.length = 0;
      const loaded = new Promise(res => loadWaiters.push(res));
      await send('Page.navigate', { url: appUrl });
      await loaded;
      for (let i = 0; i < 50; i++) {
        try {
          if (await evaluate("typeof paintAll === 'function' && typeof QR !== 'undefined'")) return;
        } catch (err) { /* the execution context is still swapping over */ }
        await sleep(100);
      }
      throw new Error('the page did not come back after reloading');
    },
    async screenshot(file) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    },
    close() {
      if (this._closed) return;
      this._closed = true;
      try { ws.close(); } catch (e) {}
      try { chrome.kill(); } catch (e) {}
    }
  };
}

/* A 1x1 PNG of a given colour, as a data URL usable straight from the page. */
function pngDataUrl(hex) {
  return "(() => { const c = document.createElement('canvas'); c.width = c.height = 8;" +
         " const x = c.getContext('2d'); x.fillStyle = '" + hex + "';" +
         " x.fillRect(0, 0, 8, 8); return c.toDataURL('image/png'); })()";
}

module.exports = { assert, Failure, openApp, pngDataUrl, findChrome };
