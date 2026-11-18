// Regression tests for release-review findings: run slot, exit codes, browser cache and CLI options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, exitCode } from '../src/cli.js';
import { missingBrowsers } from '../src/browsers.js';
import { checkReachable, parseTarget } from '../src/quick.js';
import { startDashboard, topFailures } from '../src/dashboard/server.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ip-${name}-`));

// Runs the CLI with console output captured.
async function cli(argv) {
  const out = [];
  const saved = { log: console.log, error: console.error };
  console.log = console.error = (...a) => out.push(a.join(' '));
  try {
    return { code: await main(argv), text: out.join('\n') };
  } finally {
    Object.assign(console, saved);
  }
}

test('dashboard gives the run slot back when the body is JSON but not an object', async () => {
  const d = await startDashboard({ port: 4881, open: false, home: tmp('slot'), log: () => {} });
  const post = (body) => fetch(`http://127.0.0.1:${d.port}/api/run`, { method: 'POST', headers: { 'x-ironprobe-token': d.token }, body });
  try {
    for (const body of ['null', '[]', '5', '"text"', 'true']) assert.equal((await post(body)).status, 400, `${body} is refused`);
    assert.equal((await post('{"url":""}')).status, 202, 'the next run is not told "already running"');
  } finally {
    await d.close();
  }
});

test('a stopped run never exits 0', () => {
  assert.equal(exitCode({ failed: 0 }), 0);
  assert.equal(exitCode({ failed: 0, stopped: true }), 1);
  assert.equal(exitCode({ failed: 2 }), 1);
  assert.equal(exitCode({ failed: 0, nothingRan: true }), 1);
  assert.equal(exitCode({ failed: 0, skippedCombos: 1 }), 0);
  assert.equal(exitCode({ failed: 0, skippedCombos: 1 }, { failOnSkip: true }), 1);
});

test('browser cache lives in the given home and is re-checked when the browser is gone', async () => {
  const home = tmp('cache');
  const root = tmp('browsers');
  const exe = path.join(root, 'chromium-1', 'chrome');
  fs.mkdirSync(path.dirname(exe));
  fs.writeFileSync(exe, '');
  let launches = 0;
  const pw = { chromium: { executablePath: () => exe, launch: async () => {
    launches++;
    if (!fs.existsSync(exe) && !fs.existsSync(path.join(root, 'chromium_headless_shell-1'))) throw new Error(`Executable doesn't exist at ${exe}`);
    return { close: async () => {} };
  } } };
  assert.deepEqual(await missingBrowsers(pw, ['chromium'], undefined, home), []);
  assert.ok(fs.existsSync(path.join(home, 'browsers-ok.json')), 'cache is written under the given home');
  assert.deepEqual(await missingBrowsers(pw, ['chromium'], undefined, home), []);
  assert.equal(launches, 1, 'second check is answered from the cache');

  fs.rmSync(exe);
  assert.deepEqual(await missingBrowsers(pw, ['chromium'], undefined, home), ['chromium'], 'a deleted browser is noticed');
  assert.equal(launches, 2);

  // Only the headless shell installed (what IronProbe downloads): still cacheable.
  fs.mkdirSync(path.join(root, 'chromium_headless_shell-1'));
  fs.writeFileSync(path.join(root, 'chromium_headless_shell-1', 'INSTALLATION_COMPLETE'), '');
  assert.deepEqual(await missingBrowsers(pw, ['chromium'], undefined, home), []);
  assert.deepEqual(await missingBrowsers(pw, ['chromium'], undefined, home), []);
  assert.equal(launches, 3);

  // Without a home argument, IRONPROBE_HOME is read at call time, not at import time.
  const envHome = tmp('envhome');
  const before = process.env.IRONPROBE_HOME;
  process.env.IRONPROBE_HOME = envHome;
  try {
    await missingBrowsers(pw, ['chromium']);
    assert.ok(fs.existsSync(path.join(envHome, 'browsers-ok.json')));
  } finally {
    if (before === undefined) delete process.env.IRONPROBE_HOME;
    else process.env.IRONPROBE_HOME = before;
  }
});

test('CLI: values may start with "-", unknown options are named with a hint', async () => {
  const before = process.env.IRONPROBE_HOME;
  process.env.IRONPROBE_HOME = tmp('cli');
  try {
    const token = await cli(['localhost:1', '--token', '-abc']);
    assert.equal(token.code, 2);
    assert.match(token.text, /Can't reach localhost:1|Port 1 is one that browsers refuse/, 'the token was accepted and the run went on to the address');
    assert.match((await cli(['localhost:1', '--token', '--open'])).text, /--token needs a value/);
    assert.match((await cli(['localhost:1', '--token'])).text, /--token needs a value/);

    const typo = await cli(['run', '--onyl', 'api']);
    assert.equal(typo.code, 2);
    assert.match(typo.text, /Unknown option "--onyl"\. Did you mean --only\?/);
    const odd = await cli(['localhost:1', '--zzzzzz']);
    assert.equal(odd.code, 2);
    assert.match(odd.text, /Unknown option "--zzzzzz"\. Run/);

    // Options with no command go to the dashboard (here stopped by its own port check), not "Unknown command".
    for (const argv of [['--debug', '--port', '80'], ['--port', '80', '--debug'], ['--no-open', '--port=80']]) {
      const r = await cli(argv);
      assert.equal(r.code, 2);
      assert.match(r.text, /--port must be a number between 1024 and 65535/);
    }
    assert.match((await cli(['--prot', '5000'])).text, /Unknown option "--prot"\. Did you mean --port\?/);
    assert.equal((await cli(['run', '--help'])).code, 0);
  } finally {
    if (before === undefined) delete process.env.IRONPROBE_HOME;
    else process.env.IRONPROBE_HOME = before;
  }
});

test('setup errors say which part of the run could not start', () => {
  const [card] = topFailures({ engineErrors: [{ engine: 'ui', message: 'boom', passed: false, failures: ['boom'], category: 'infrastructure' }] });
  assert.equal(card.area, 'Setup');
  assert.equal(card.where, 'Browser checks');
});

test('the reachability check stops when the run is cancelled', async () => {
  const http = await import('node:http');
  const server = http.createServer(() => {}); // accepts, never answers
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  try {
    await assert.rejects(checkReachable(parseTarget(`127.0.0.1:${server.address().port}`), 10000, controller.signal), /Stopped before the test started/);
    assert.ok(Date.now() - started < 3000, 'did not wait for the 10 second timeout');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
