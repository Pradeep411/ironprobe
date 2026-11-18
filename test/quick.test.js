// Quick mode, HAR import, health score and dashboard security.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTarget, hostsFor, placeUploads, buildQuickConfig, listRuns } from '../src/quick.js';
import { importHar, detectKind } from '../src/importers/har.js';
import { healthScore } from '../src/score.js';
import { startDashboard, topFailures, friendlyWarnings } from '../src/dashboard/server.js';

test('parseTarget accepts bare hosts and refuses unsafe input', () => {
  assert.equal(parseTarget('myapp.com').toString(), 'https://myapp.com/');
  assert.equal(parseTarget('localhost:3000').origin, 'http://localhost:3000');
  assert.throws(() => parseTarget(''), /Paste/);
  assert.throws(() => parseTarget('file:///etc/passwd'), /http/);
  assert.throws(() => parseTarget('https://u:p@x.com'), /password/);
  assert.throws(() => parseTarget('javascript:alert(1)'), /http|address/);
  assert.deepEqual(hostsFor(new URL('https://shop.example.com')), ['shop.example.com']);
  assert.deepEqual(hostsFor(new URL('https://example.co.uk')), ['example.co.uk', 'www.example.co.uk']);
  assert.deepEqual(hostsFor(new URL('https://www.example.com')), ['www.example.com', 'example.com']);
  assert.deepEqual(hostsFor(new URL('http://localhost:4010')), ['localhost:4010']);
});

test('uploads are detected by content, saved with safe names, never executed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-up-'));
  const r = placeUploads([
    { name: '../../evil.json', content: JSON.stringify({ openapi: '3.0.0', paths: {} }) },
    { name: 'c.json', content: JSON.stringify({ info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/' }, item: [] }) },
    { name: 'r.har', content: JSON.stringify({ log: { entries: [{ request: { method: 'GET', url: 'https://a.com/' }, response: { status: 200 } }] } }) },
  ], dir);
  assert.deepEqual(r.api.map((e) => Object.keys(e)[0]), ['openapi', 'postman', 'har']);
  assert.ok(fs.readdirSync(dir).every((f) => !f.includes('..') && !f.includes('/')));
  assert.throws(() => placeUploads([{ name: 'x.txt', content: 'hello: [' }], dir), /not JSON or YAML/);
  assert.throws(() => placeUploads([{ name: 'e.har', content: JSON.stringify({ log: { entries: [] } }) }], dir), /no requests/);
  assert.throws(() => placeUploads([{ name: 'x.json', content: '{"a":1}' }], dir), /not a Postman/);
  const cfg = buildQuickConfig(new URL('https://a.com/shop'), { api: r.api, auth: true });
  assert.equal(cfg.ui.pages[0], '/shop');
  assert.ok(cfg.api.every((e) => e.headers?.Authorization === '{{__ironprobe_auth}}'), 'token reaches every API file');
  assert.deepEqual(cfg.ui.devices, ['Desktop', 'Pixel 7']);
  assert.ok(!JSON.stringify(cfg).includes('Bearer '), 'token never written into the config');
});

test('HAR import replays only safe requests to the tested host', async () => {
  const har = { log: { entries: [
    { request: { method: 'GET', url: 'https://a.com/api/me' }, response: { status: 200, content: { mimeType: 'application/json' } }, time: 120 },
    { request: { method: 'GET', url: 'https://a.com/api/me' }, response: { status: 200 } },
    { request: { method: 'POST', url: 'https://a.com/api/pay' }, response: { status: 201 } },
    { request: { method: 'GET', url: 'https://tracker.io/p' }, response: { status: 200 } },
    { request: { method: 'GET', url: 'https://a.com/logo.png' }, response: { status: 200 } },
  ] } };
  const s = importHar(har, { allowedHosts: ['a.com'] });
  assert.equal(s.tests.length, 1);
  assert.equal(s.tests[0].expect.status, 200);
  assert.ok(s.warnings.some((w) => /change data/.test(w)) && s.warnings.some((w) => /other hosts/.test(w)));
  const { checkResponse } = await import('../src/assertions.js');
  assert.deepEqual(checkResponse(s.tests[0].expect, { status: 200, ms: 5, headers: { 'content-type': 'application/json; charset=utf-8' }, text: '{}', json: {} }), [], 'recorded JSON checks pass on JSON');
  assert.equal(detectKind(har), 'har');
  assert.throws(() => importHar({}), /HAR/);
});

test('health score averages areas so one big area cannot hide another', () => {
  const ok = { passed: true };
  const bad = { passed: false };
  const h = healthScore({ api: [bad, bad], crawl: { pages: Array(30).fill(ok) } });
  assert.equal(h.score, 50);
  assert.equal(healthScore({}).score, null);
  assert.equal(healthScore({ api: [ok] }).label, 'Healthy');
});

test('fix-first list groups devices and explains logins; warnings are plain', () => {
  const r = { api: [{ name: 'getUser', passed: false, failures: ['status: expected 200, got 401'] }],
    ui: { tests: [], pages: [
      { url: 'http://a.com/x', browser: 'chromium', device: 'Desktop', passed: false, failures: ['2 issues'], category: 'app' },
      { url: 'http://a.com/x', browser: 'chromium', device: 'iPhone 15', passed: false, failures: ['2 issues'], category: 'app' },
    ] } };
  const f = topFailures(r);
  assert.equal(f.length, 2);
  assert.equal(f[0].cause, 'app', 'app bugs come first');
  assert.equal(f[1].cause, 'login');
  assert.deepEqual(f[0].devices, ['Desktop', 'iPhone 15']);
  assert.deepEqual(friendlyWarnings(['OpenAPI import: "x" needs auth', 'Only GET/HEAD operations were generated']), []);
});

test('dashboard refuses requests without the token, from other sites, or for other hosts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-home-'));
  const d = await startDashboard({ port: 4870, open: false, home, log: () => {} });
  const base = `http://127.0.0.1:${d.port}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.match((await fetch(`${base}/`)).headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(`${base}/api/history`)).status, 401);
    assert.equal((await fetch(`${base}/api/run`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/run`, { method: 'POST', headers: { origin: 'https://evil.example', 'x-ironprobe-token': d.token }, body: '{}' })).status, 403);
    const s = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'x-ironprobe-token': d.token } });
    assert.equal(s.status, 200);
    const cookie = s.headers.get('set-cookie').split(';')[0];
    assert.match(s.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(`${base}/api/history`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/run`, { method: 'POST', headers: { cookie }, body: '{}' })).status, 401, 'cookie alone cannot start a run');
    assert.equal((await fetch(`${base}/r/x/2026-01-01T00-00-00-000Z/..%2F..%2F..%2Fetc%2Fpasswd`, { headers: { cookie } })).status, 404);
    const bad = await fetch(`${base}/api/run`, { method: 'POST', headers: { 'x-ironprobe-token': d.token, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'file:///etc/passwd' }) });
    assert.equal(bad.status, 202);
    assert.deepEqual(listRuns(home), []);
  } finally {
    await d.close();
  }
});

test('quick mode never reaches private networks and rejects bomb files', async () => {
  const { isPrivateAddress } = await import('../src/guard-proxy.js');
  const { nestingDepth } = await import('../src/quick.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  assert.equal(nestingDepth('{"a":[1,{"b":"[[[["}]}'), 3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-deep-'));
  const t = Date.now();
  assert.throws(() => placeUploads([{ name: 'd.json', content: '['.repeat(2_000_000) }], dir), /nested too deeply/);
  assert.ok(Date.now() - t < 2000);
});

test('api entry headers apply to every importer, including OpenAPI suites without setup', async () => {
  const { loadConfig } = await import('../src/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-cfg-'));
  fs.writeFileSync(path.join(dir, 'o.yaml'), "openapi: 3.0.0\ninfo: {title: t, version: '1'}\npaths:\n  /a:\n    get:\n      responses: {'200': {description: ok}}\n");
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/' }, item: [{ name: 'get', request: { method: 'GET', url: '{{baseUrl}}/a' } }, { name: 'del', request: { method: 'DELETE', url: '{{baseUrl}}/a' } }] }));
  fs.writeFileSync(path.join(dir, 'ironprobe.config.yaml'), 'baseUrl: http://localhost:1\nallowedHosts: [localhost]\napi:\n  - openapi: o.yaml\n    headers: { X-T: "1" }\n  - postman: c.json\n    safeOnly: true\n    headers: { X-T: "2" }\n');
  const { apiSuites, warnings } = loadConfig(path.join(dir, 'ironprobe.config.yaml'));
  assert.equal(apiSuites[0].tests[0].request.headers['X-T'], '1');
  assert.deepEqual(apiSuites[1].tests.map((t) => t.request.method), ['GET']);
  assert.equal(apiSuites[1].tests[0].request.headers['X-T'], '2');
  assert.ok(warnings.some((w) => /change data/.test(w)));
});

test('HAR: cached 304s and redirects replay sensibly, secret query values are masked', () => {
  const har = { log: { entries: [
    { request: { method: 'GET', url: 'https://a.com/app.json' }, response: { status: 304 } },
    { request: { method: 'GET', url: 'https://a.com/old' }, response: { status: 301 } },
    { request: { method: 'GET', url: 'https://a.com/api?api_key=sk_live_abcdefgh1234&page=2' }, response: { status: 200 } }, // ironprobe:ignore (fake test value)
  ] } };
  const s = importHar(har, { allowedHosts: ['a.com'] });
  assert.deepEqual(s.tests.map((t) => t.expect.status ?? `<=${t.expect.maxStatus}`), [200, '<=399', 200]);
  assert.ok(s.secrets.includes('sk_live_abcdefgh1234'));
  assert.ok(!s.tests[2].name.includes('sk_live'), 'secret never in the test name');
});

test('dashboard frees the run slot when an upload is cancelled mid-way', async () => {
  const net = await import('node:net');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-home2-'));
  const d = await startDashboard({ port: 4871, open: false, home, log: () => {} });
  try {
    await new Promise((resolve) => {
      const sock = net.connect(d.port, '127.0.0.1', () => {
        sock.write(`POST /api/run HTTP/1.1\r\nHost: 127.0.0.1:${d.port}\r\nx-ironprobe-token: ${d.token}\r\ncontent-type: application/json\r\ncontent-length: 100000\r\n\r\n{"url":"`);
        setTimeout(() => { sock.destroy(); setTimeout(resolve, 200); }, 100);
      });
    });
    const r = await fetch(`http://127.0.0.1:${d.port}/api/run`, { method: 'POST', headers: { 'x-ironprobe-token': d.token }, body: '{bad' });
    assert.equal(r.status, 400, 'a new request is not told "already running"');
  } finally {
    await d.close();
  }
});

test('a run stopped early gets no score and is not saved to the trend', () => {
  const r = { summary: { stopped: true }, api: [{ passed: true }] };
  const h = healthScore(r);
  assert.equal(h.score, null);
  assert.equal(h.label, 'Stopped early');
});

test('Postman base URLs on another host are switched to the typed address', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-rebase-'));
  const col = { info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/' }, item: [], variable: [{ key: 'base', value: 'https://staging.example.com/api/' }, { key: 'name', value: 'x' }] };
  const r = placeUploads([{ name: 'c.json', content: JSON.stringify(col) }], dir, { target: new URL('http://localhost:4015/') });
  assert.equal(r.vars.base, 'http://localhost:4015/api');
  assert.equal(r.vars.name, undefined);
  assert.ok(r.notes.some((n) => /switched to localhost:4015/.test(n)));
});

test('Postman import masks secret-looking values in request addresses', async () => {
  const { importPostman } = await import('../src/importers/postman.js');
  const fake = ['Url', 'Token', 'Value-998877'].join('');
  const s = importPostman({ info: { name: 'c' }, item: [
    { name: 'a', request: { method: 'GET', url: `{{base}}/api/echo?token=${fake}&page=2` } },
    { name: 'b', request: { method: 'GET', url: '{{base}}/api/echo?token={{tok}}' } },
  ] });
  assert.deepEqual(s.secrets, [fake]);
});

test('IPv4-translated IPv6 loopback counts as private', async () => {
  const { isPrivateAddress } = await import('../src/guard-proxy.js');
  assert.equal(isPrivateAddress('::ffff:0:7f00:1'), true);
  assert.equal(isPrivateAddress('::ffff:0:808:808'), false);
});
