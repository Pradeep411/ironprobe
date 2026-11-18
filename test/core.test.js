import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHostAllowed, assertAllowed, validateLoadConfig, Redactor, SafetyError } from '../src/safety.js';
import { query } from '../src/jsonpath.js';
import { checkResponse } from '../src/assertions.js';
import { importPostman, translateScript } from '../src/importers/postman.js';
import { importOpenApi } from '../src/importers/openapi.js';
import { scanText } from '../src/secrets.js';
import { renderHtml } from '../src/report/html.js';
import { renderJunit } from '../src/report/junit.js';
import { interpolate } from '../src/vars.js';
import { categorize } from '../src/util.js';

test('allow-list: exact, wildcard, scheme and IPv6', () => {
  assert.equal(isHostAllowed('http://localhost:3000/x', ['localhost']), true);
  assert.equal(isHostAllowed('https://api.myapp.com', ['*.myapp.com']), true);
  assert.equal(isHostAllowed('https://myapp.com', ['*.myapp.com']), true);
  assert.equal(isHostAllowed('https://evilmyapp.com', ['*.myapp.com']), false);
  assert.equal(isHostAllowed('https://myapp.com.evil.io', ['myapp.com']), false);
  assert.equal(isHostAllowed('file:///etc/passwd', ['localhost']), false);
  assert.equal(isHostAllowed('http://[::1]:8080/', ['::1']), true);
  assert.equal(isHostAllowed('not a url', ['localhost']), false);
  assert.throws(() => assertAllowed('https://google.com', ['localhost']), SafetyError);
});

test('load safety: ownership required and caps enforced', () => {
  assert.throws(() => validateLoadConfig({ url: '/' }, {}), SafetyError);
  assert.throws(() => validateLoadConfig({ url: '/', concurrency: 500 }, { iOwnThisTarget: true }), /capped/);
  assert.throws(() => validateLoadConfig({ url: '/', durationSec: 999 }, { iOwnThisTarget: true }), /capped/);
  assert.throws(() => validateLoadConfig({ url: '/', maxRps: -1 }, { iOwnThisTarget: true }), /positive/);
  assert.equal(validateLoadConfig({ url: '/', concurrency: 5 }, { iOwnThisTarget: true }).concurrency, 5);
});

test('redactor masks secrets and auth headers everywhere', () => {
  const r = new Redactor();
  r.add('supersecret');
  const out = r.redact({ a: 'x supersecret y', headers: { Authorization: 'Bearer abc', 'Content-Type': 'json' }, list: ['supersecret'] });
  assert.equal(out.a, 'x *** y');
  assert.equal(out.headers.Authorization, '***');
  assert.equal(out.headers['Content-Type'], 'json');
  assert.deepEqual(out.list, ['***']);
});

test('env interpolation registers secrets', () => {
  process.env.IP_TEST_SECRET = 'hunter2hunter2';
  const r = new Redactor();
  const v = interpolate({ h: 'Bearer {{env.IP_TEST_SECRET}}', u: '{{baseUrl}}/x' }, { baseUrl: 'http://h' }, r, []);
  assert.equal(v.u, 'http://h/x');
  assert.equal(r.redact(v.h), 'Bearer ***');
});

test('jsonpath subset', () => {
  const d = { a: { b: [{ c: 1 }, { c: 2 }] }, s: 'abc', 'odd-key': true };
  assert.deepEqual(query(d, '$.a.b[1].c'), { found: true, value: 2 });
  assert.deepEqual(query(d, '$.a.b.length'), { found: true, value: 2 });
  assert.deepEqual(query(d, "$['odd-key']"), { found: true, value: true });
  assert.equal(query(d, '$.a.zz').found, false);
  assert.equal(query(d, '$.a.b[9]').found, false);
  assert.throws(() => query(d, '$..a'));
  assert.throws(() => query(d, 'a.b'));
});

test('assertions: status, maxStatus, latency, body matchers, schema', () => {
  const res = { status: 200, ms: 50, headers: { 'content-type': 'application/json' }, text: '{"id":3,"tags":["x"]}', json: { id: 3, tags: ['x'] } };
  assert.deepEqual(checkResponse({ status: 200, maxMs: 100, headers: { 'content-type': '/json/' }, body: { '$.id': { gte: 3, type: 'number' }, '$.tags': { contains: 'x' } }, schema: { type: 'object', required: ['id'] } }, res), []);
  assert.equal(checkResponse({ status: 201 }, res).length, 1);
  assert.equal(checkResponse({ maxMs: 10 }, res).length, 1);
  assert.equal(checkResponse({ body: { '$.missing': { exists: true } } }, res).length, 1);
  assert.equal(checkResponse({ maxStatus: 499 }, { ...res, status: 500 }).length, 1);
  assert.equal(checkResponse({ schema: { type: 'object', required: ['nope'] } }, res).length, 1);
});

test('postman: translates common assertions and never executes scripts', () => {
  globalThis.__pwned = false;
  const t = translateScript([
    'pm.test("ok", () => { pm.response.to.have.status(201); });',
    'pm.expect(pm.response.responseTime).to.be.below(300);',
    'var jsonData = pm.response.json();',
    'pm.environment.set("tok", jsonData.data.token);',
    'pm.expect(jsonData.name).to.eql("Bob");',
    'eval("globalThis.__pwned = true");',
  ]);
  assert.equal(t.expect.status, 201);
  assert.equal(t.expect.maxMs, 300);
  assert.equal(t.extract.tok, '$.data.token');
  assert.equal(t.expect.body['$.name'], 'Bob');
  assert.equal(t.untranslated.length, 1);
  assert.equal(globalThis.__pwned, false);
  const suite = importPostman({ info: { name: 'c' }, item: [{ name: 'f', auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{t}}' }] }, item: [{ name: 'r', request: { method: 'GET', url: { raw: '{{base}}/x' } } }] }] });
  assert.equal(suite.tests[0].request.headers.Authorization, 'Bearer {{t}}');
  assert.throws(() => importPostman({}));
});

test('openapi: safe GET-only default, refs resolved, fuzz cases generated', () => {
  const spec = {
    openapi: '3.0.0', info: { title: 't' },
    paths: {
      '/a/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }], responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } } } }, delete: { responses: { 204: {} } } },
    },
    components: { schemas: { A: { type: 'object', properties: { n: { type: 'string', nullable: true } } } } },
  };
  const s = importOpenApi(spec, { fuzz: true });
  const main = s.tests.find((t) => !t.fuzz);
  assert.equal(main.request.url, '/a/1');
  assert.deepEqual(main.expect.schema.definitions.A.properties.n.type, ['string', 'null']);
  assert.equal(main.expect.schema.allOf[0].$ref, '#/definitions/A');
  assert.ok(!s.tests.some((t) => t.request.method === 'DELETE'));
  assert.ok(s.tests.filter((t) => t.fuzz).length >= 4);
  assert.ok(s.tests.filter((t) => t.fuzz).every((t) => t.expect.maxStatus === 499));
  assert.ok(importOpenApi(spec, { includeWrites: true }).tests.some((t) => t.request.method === 'DELETE'));
});

test('secret scanner finds real secrets and ignores {{env}} references', () => {
  // Fake token, assembled at runtime so secret scanners do not flag this file.
  const fakeToken = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz', '0123456789AB'].join('');
  const found = scanText(`token: ${fakeToken}\n` + 'key: "{{env.API_KEY}}"\nAuthorization: Bearer {{token}}\n"password": "hunter2hunter2"', 'f');  // ironprobe:ignore (fake test value)
  assert.deepEqual(found.map((f) => f.kind).sort(), ['Credential field', 'GitHub token']);
  assert.ok(!found.some((f) => f.preview.includes('abcdefghijklmnop')));
});

test('report escapes hostile content and uses a strict CSP', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const r = {
    meta: { name: evil, version: '0.1.0', startedAt: new Date().toISOString(), durationMs: 10, platform: 'x', budgets: {} },
    api: [{ suite: 's', name: evil, method: 'GET', url: 'http://localhost/', status: 500, ms: 5, passed: false, failures: [evil], responseSnippet: evil, category: 'app' }],
    ui: { tests: [], pages: [], skippedCombos: [] }, crawl: null, load: null, warnings: [evil],
  };
  const html = renderHtml(r, []);
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(!/<script/i.test(html));
  const xml = renderJunit(r);
  assert.ok(!xml.includes('<script>'));
});

test('failure categories', () => {
  assert.equal(categorize('request failed: fetch failed'), 'infrastructure');
  assert.equal(categorize('step 2 (click): Timeout 10000ms exceeded. waiting for locator'), 'test');
  assert.equal(categorize('status: expected 404, got 500'), 'app');
});

import { safeRegex, clampRetries, sameOrigin } from '../src/safety.js';
import { mockResponse, sample } from '../src/mock.js';
import { exportPlaywright } from '../src/export/playwright.js';
import { loadConfig } from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('allow-list: ports, wildcard edge cases, trailing dots', () => {
  assert.equal(isHostAllowed('http://localhost:6379', ['localhost:3000']), false);
  assert.equal(isHostAllowed('http://localhost:3000', ['localhost:3000']), true);
  assert.equal(isHostAllowed('https://evil.com.', ['*.']), false);
  assert.equal(isHostAllowed('https://evil.com', ['*.com']), false);
  assert.equal(isHostAllowed('http://localhost@evil.com/', ['localhost']), false);
  assert.equal(sameOrigin('http://a.com/x', 'http://a.com/y'), true);
});

test('redactor masks URL-encoded and base64 forms; sensitive header names', () => {
  const r = new Redactor();
  r.add('s3cret token/"x');
  assert.equal(r.redact('t=s3cret%20token%2F%22x'), 't=***');
  assert.equal(r.redact('Basic ' + Buffer.from('s3cret token/"x').toString('base64')), 'Basic ***');
  assert.deepEqual(r.redact({ 'x-auth-token': 'abc', 'api-key': 'k', accept: 'json' }), { 'x-auth-token': '***', 'api-key': '***', accept: 'json' });
});

test('regex checks run in linear time and cap input', () => {
  // Patterns that hang backtracking engines finish fast on the linear engine.
  for (const p of ['^(a+)+$', '((a+))+$', '(a|aa)+$', '(x*)*y', '\\w*\\w*\\w*\\w*\\w*\\w*!$']) {
    const t0 = Date.now();
    safeRegex(p).test('a'.repeat(9999));
    assert.ok(Date.now() - t0 < 500, `${p} took ${Date.now() - t0} ms`);
  }
  assert.throws(() => safeRegex('(a)\\1'), /back-references/);
  assert.equal(safeRegex('^APPLICATION/json', 'i').test('application/JSON; charset=utf-8'), true);
  assert.equal(safeRegex('json').test('application/json'), true);
  const t = Date.now();
  assert.throws(() => safeRegex('^a+$').test('a'.repeat(200000) + '!'), /limit/);
  assert.ok(Date.now() - t < 1000);
  assert.equal(clampRetries(Infinity, 1), 1);
  assert.equal(clampRetries(99), 5);
  const res = { status: 200, ms: 1, headers: {}, text: '', json: { a: 'aaaa' } };
  assert.deepEqual(checkResponse({ body: { '$.a': { matches: '/^(a+)+$/' } } }, res), []);
  assert.match(checkResponse({ body: { '$.a': { matches: '/(a)\\1/' } } }, res)[0], /back-references/);
});

test('openapi: exponential $ref fan-out imports instantly; recursive schemas validate', () => {
  const schemas = {};
  for (let i = 0; i < 30; i++) schemas[`S${i}`] = { type: 'object', properties: { a: { $ref: `#/components/schemas/S${i + 1}` }, b: { $ref: `#/components/schemas/S${i + 1}` } } };
  schemas.S30 = { type: 'string' };
  schemas.Node = { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, child: { $ref: '#/components/schemas/Node' } } };
  const t = Date.now();
  const s = importOpenApi({ openapi: '3.0.0', info: { title: 'x' }, paths: { '/n': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } }, '/a': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } } } } } } }, components: { schemas } });
  assert.ok(Date.now() - t < 500);
  const n = s.tests[0].expect;
  assert.deepEqual(checkResponse(n, { status: 200, ms: 1, headers: {}, text: '', json: { id: 1, child: { id: 2 } } }), []);
  assert.equal(checkResponse(n, { status: 200, ms: 1, headers: {}, text: '', json: { id: 1, child: { id: 'x' } } }).length, 1);
});

test('mock server: examples, generated samples, 404/405', () => {
  const spec = { openapi: '3.0.0', info: { title: 'm' }, paths: {
    '/items/{id}': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } } } },
    '/hello': { get: { responses: { 200: { content: { 'application/json': { example: { hi: 1 } } } } } } },
  }, components: { schemas: { Item: { type: 'object', properties: { id: { type: 'integer' }, at: { type: 'string', format: 'date-time' } } } } } };
  assert.deepEqual(mockResponse(spec, 'GET', '/hello').body, { hi: 1 });
  assert.deepEqual(mockResponse(spec, 'GET', '/items/7').body, { id: 1, at: '2026-01-01T00:00:00Z' });
  assert.equal(mockResponse(spec, 'POST', '/hello').status, 405);
  assert.equal(mockResponse(spec, 'GET', '/nope').status, 404);
  assert.deepEqual(sample({ type: 'array', items: { type: 'boolean' } }, {}), [true]);
});

test('export: env vars, captured vars and status lists become valid code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-export-'));
  exportPlaywright([{ name: 'S', tests: [{ name: 't', steps: [{ goto: '/x?k={{env.KEY}}' }, { request: { url: '/api/{{id}}', expect: { status: [200, 204] } } }] }] }], { baseUrl: 'http://localhost:1' }, dir);
  const code = fs.readFileSync(path.join(dir, 's.spec.ts'), 'utf8');
  assert.match(code, /process\.env\["KEY"\]/);
  assert.match(code, /vars\["id"\]/);
  assert.match(code, /toContain\(res\.status\(\)\)/);
  assert.doesNotMatch(code, /NaN/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config validation: unknown steps, empty steps, outputs outside the project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-cfg-'));
  const write = (f, t) => fs.writeFileSync(path.join(dir, f), t);
  write('ui.yaml', 'tests:\n  - name: t\n    steps:\n      - clik: "#a"\n');
  write('c.yaml', 'baseUrl: http://localhost:1\nallowedHosts: [localhost]\nui:\n  suites: [ui.yaml]\n');
  assert.throws(() => loadConfig(path.join(dir, 'c.yaml')), /unknown action "clik"/);
  write('ui.yaml', 'tests:\n  - name: t\n    steps:\n      -\n');
  assert.throws(() => loadConfig(path.join(dir, 'c.yaml')), /must be one action/);
  write('c.yaml', 'baseUrl: http://localhost:1\nallowedHosts: [localhost]\noutput: ../../elsewhere\n');
  assert.throws(() => loadConfig(path.join(dir, 'c.yaml')), /inside the project/);
  write('c.yaml', 'baseUrl: http://evil.com\nallowedHosts: [localhost]\n');
  assert.throws(() => loadConfig(path.join(dir, 'c.yaml')), /not in allowedHosts/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mock serves under the servers base path; scan catches pretty-printed Postman credentials', async () => {
  const { mockResponse } = await import('../src/mock.js');
  const { scanText } = await import('../src/secrets.js');
  const spec = { servers: [{ url: 'https://api.example.com/v1' }], paths: { '/n/{id}': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/N' } } } } } } } }, components: { schemas: { N: { type: 'object', properties: { id: { type: 'integer' }, parent: { $ref: '#/components/schemas/N' } } } } } };
  const r = mockResponse(spec, 'GET', '/v1/n/3');
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.id, 'number');
  const pm = JSON.stringify({ auth: { apikey: [{ key: 'value', value: 'live_abcdef1234567890' }, { key: 'key', value: 'x-api-key' }] }, variable: [{ key: 'password', value: 'hunter2pass' }] }, null, 2);
  const kinds = scanText(pm, 'c.json');
  assert.equal(kinds.length, 2);
  assert.equal(scanText(JSON.stringify([{ key: 'password', value: '{{env.PASS}}' }], null, 2), 'c.json').length, 0);
});
