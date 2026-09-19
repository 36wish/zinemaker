/* Test runner.  node test/run.js [name-filter]
   Node-only suites run first, then every browser suite shares one Chrome. */

'use strict';

const fs = require('fs');
const path = require('path');
const { openApp, Failure } = require('./harness');

const filter = process.argv[2] || '';
const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort();

const suites = files.map(f => Object.assign({ file: f }, require(path.join(__dirname, f))));

const GREEN = s => '\u001b[32m' + s + '\u001b[0m';
const RED = s => '\u001b[31m' + s + '\u001b[0m';
const DIM = s => '\u001b[2m' + s + '\u001b[0m';

let passed = 0, failed = 0, skipped = 0;
const failures = [];

async function runSuite(suite, page) {
  const matched = [];
  const ctx = {
    page: page,
    check(name, fn) { matched.push({ name: name, fn: fn }); }
  };
  await suite.collect(ctx);

  const use = matched.filter(t => !filter ||
    (suite.name + ' ' + t.name).toLowerCase().indexOf(filter.toLowerCase()) >= 0);
  if (!use.length) { skipped += matched.length; return; }

  console.log('\n' + suite.name);
  if (suite.setup) {
    try {
      await suite.setup();
    } catch (err) {
      failed++;
      failures.push({ suite: suite.name, test: 'setup', err: err });
      console.log('  ' + RED('FAIL') + '  setup: ' + (err.message || err));
      return;
    }
  }
  for (const t of use) {
    const started = Date.now();
    try {
      await t.fn();
      const ms = Date.now() - started;
      passed++;
      console.log('  ' + GREEN('pass') + '  ' + t.name + (ms > 400 ? DIM(' ' + ms + 'ms') : ''));
    } catch (err) {
      failed++;
      failures.push({ suite: suite.name, test: t.name, err: err });
      console.log('  ' + RED('FAIL') + '  ' + t.name);
      console.log('        ' + String(err instanceof Failure ? err.message : err.stack)
        .split('\n').join('\n        '));
    }
  }
  if (suite.teardown) {
    try { await suite.teardown(); }
    catch (err) { console.log('  ' + RED('FAIL') + '  teardown: ' + (err.message || err)); }
  }
}

(async () => {
  const started = Date.now();
  let page = null;

  for (const suite of suites.filter(s => !s.browser)) await runSuite(suite, null);

  const browserSuites = suites.filter(s => s.browser);
  if (browserSuites.length) {
    page = await openApp();
    try {
      for (const suite of browserSuites) await runSuite(suite, page);
      if (page.consoleErrors.length) {
        failed++;
        console.log('\n' + RED('FAIL') + '  the page logged errors');
        page.consoleErrors.forEach(e => console.log('        ' + e));
        failures.push({ suite: 'browser', test: 'no console errors', err: new Error(page.consoleErrors.join('\n')) });
      }
    } finally {
      page.close();
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n' + (failed ? RED(failed + ' failed') + ', ' : '') +
    GREEN(passed + ' passed') + (skipped ? ', ' + skipped + ' filtered out' : '') +
    DIM('  (' + secs + 's)'));

  // let the browser sockets and any server finish closing before exiting
  await new Promise(res => setTimeout(res, 150));
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('\n' + RED('the runner itself failed:'));
  console.error(err);
  process.exit(2);
});
