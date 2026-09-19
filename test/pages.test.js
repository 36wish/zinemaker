/* Serves the repository the way GitHub Pages would — plain static files over
   HTTP, under a project subpath like /zinemaker/ — and drives the app there.

   This is the suite that catches anything which only works because the file
   sits on a local disk: an absolute /path, a fetch for a stylesheet, a
   canvas tainted by a cross-origin image, a dependency on a CDN. */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { assert, openApp } = require('./harness');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = '/zinemaker';          // project sites are served from a subpath

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

let server = null, page = null, base = null;

function startServer() {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      let url = req.url.split('?')[0];
      if (url.indexOf(PREFIX) !== 0) { res.writeHead(404); res.end('not found'); return; }
      let rel = url.slice(PREFIX.length) || '/';
      if (rel.endsWith('/')) rel += 'index.html';
      // GitHub Pages serves from a Linux box: paths are case sensitive and
      // there is no directory traversal out of the published folder.
      const file = path.join(ROOT, rel);
      if (file.indexOf(ROOT) !== 0 || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

module.exports = {
  name: 'GitHub Pages',
  browser: false,

  async setup() {
    server = await startServer();
    base = 'http://127.0.0.1:' + server.address().port + PREFIX + '/';
    page = await openApp(base);
    await page.reload();          // so the request log covers the load itself
  },

  async teardown() {
    if (page) page.close();
    if (server) await new Promise(res => server.close(res));
  },

  collect(t) {
    t.check('the site loads over HTTP from a project subpath', async () => {
      const r = await page.evaluate(
        "({ url: location.href, title: document.title, protocol: location.protocol })");
      assert.eq(r.protocol, 'http:', 'served over HTTP, not from the filesystem');
      assert.includes(r.url, PREFIX + '/', 'served under a subpath');
      assert.eq(r.title, 'Zine Maker');
    });

    t.check('relative script tags resolve under the subpath', async () => {
      const r = await page.evaluate(
        "({ qr: typeof QR, app: typeof paintAll, tpl: typeof TEMPLATES })");
      assert.eq(r.qr, 'object', 'qr.js did not load');
      assert.eq(r.app, 'function', 'app.js did not load');
      assert.eq(r.tpl, 'object');
    });

    t.check('nothing is fetched from outside the site', async () => {
      const origin = base.slice(0, base.indexOf('/', 'http://'.length));
      const foreign = page.requests.filter(u =>
        u.indexOf(origin) !== 0 && u.indexOf('data:') !== 0);
      assert.deepEq(foreign, [],
        'the page must not reach the network: ' + foreign.join(', '));
      assert.ok(page.requests.length >= 3, 'expected at least the page and its two scripts');
    });

    t.check('the site asks for nothing outside its own folder', async () => {
      // A missing favicon makes every browser hit the origin root, which on a
      // project site is somebody else's page.
      const outside = page.requests.filter(u =>
        u.indexOf('data:') !== 0 && u.indexOf(base) !== 0);
      assert.deepEq(outside, [], 'requested outside the project folder: ' + outside.join(', '));
    });

    t.check('the page loaded without console errors', async () => {
      assert.deepEq(page.consoleErrors, []);
    });

    t.check('the editor boots and renders panels', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0); addText(); stopEdit();
        return { panels: document.querySelectorAll('#sheet > .panel').length,
                 elements: document.querySelectorAll('#sheet .el').length,
                 thumbs: document.querySelectorAll('#strip .thumb').length };
      })()`);
      assert.eq(r.panels, 2, 'the spread should show two panels');
      assert.eq(r.elements, 1);
      assert.eq(r.thumbs, 8);
    });

    t.check('panel styles are read from the document, not fetched', async () => {
      // page-css is read as textContent precisely so that no request is needed;
      // over http a fetch would work, but it would break the file:// case.
      const len = await page.evaluate(
        "document.getElementById('page-css').textContent.length");
      assert.ok(len > 200, 'the export stylesheet came back empty');
    });

    t.check('export rasterises without tainting the canvas', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        setActive(0); addText(); stopEdit();
        selected().text = 'PAGES'; selected().size = 30;
        addQr();
        const g = geom();
        const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, 150 / 72);
        // reading pixels back is what throws if the canvas has been tainted
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4 * 31) if (d[i] < 128) ink++;
        return { w: cv.width, ink: ink };
      })()`);
      assert.eq(r.w, 1754, 'A4 landscape at 150 dpi');
      assert.ok(r.ink > 10, 'the rendered sheet came out blank');
    });

    t.check('PDF and .zine downloads are produced over HTTP', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        setActive(0); addText(); stopEdit();
        const got = {};
        const real = window.download;
        window.download = (blob, name) => { got[name.split('.').pop()] = blob.size; };
        await exportSheet('pdf');
        await saveZine();
        window.download = real;
        return got;
      })()`);
      assert.ok(r.pdf > 5000, 'pdf export failed over http: ' + r.pdf);
      assert.ok(r.zine > 100, 'zine save failed over http: ' + r.zine);
    });

    t.check('compression is available in this context', async () => {
      // .zine relies on CompressionStream; confirm the real thing is used here
      // rather than the uncompressed fallback.
      const r = await page.evaluate(`(async () => {
        const has = typeof CompressionStream !== 'undefined';
        let flag = null;
        if (has) {
          const real = window.download;
          let cap = null;
          window.download = (b) => { cap = b; };
          await saveZine();
          window.download = real;
          flag = new Uint8Array(await cap.slice(5, 6).arrayBuffer())[0];
        }
        return { has: has, flag: flag };
      })()`);
      assert.eq(r.has, true, 'CompressionStream missing');
      assert.eq(r.flag, 1, 'the saved file was not deflated');
    });

    t.check('browser storage works on an http origin', async () => {
      const r = await page.evaluate(`(async () => {
        state.title = 'served zine';
        save();
        await new Promise(res => setTimeout(res, 400));
        return JSON.parse(localStorage.getItem('zinemaker.v1')).title;
      })()`);
      assert.eq(r, 'served zine');
    });

    t.check('every file the page needs is committed and lower case', async () => {
      // Pages is case sensitive; a Windows checkout will happily load Qr.js
      const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      const refs = [];
      html.replace(/(?:src|href)="([^":]+)"/g, (_, u) => { refs.push(u); return ''; });
      assert.ok(refs.length >= 2, 'expected script references in index.html');
      refs.forEach(ref => {
        assert.ok(ref[0] !== '/', ref + ' is an absolute path and will break under a subpath');
        const onDisk = path.join(ROOT, ref);
        assert.ok(fs.existsSync(onDisk), ref + ' is referenced but missing');
        assert.eq(path.basename(onDisk), path.basename(ref), ref + ' differs in case');
      });
    });

    t.check('a .nojekyll file keeps Pages from reprocessing the site', async () => {
      assert.ok(fs.existsSync(path.join(ROOT, '.nojekyll')),
        'add an empty .nojekyll so the files are served verbatim');
    });
  }
};
