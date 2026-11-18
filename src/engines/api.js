// API engine: request suites with variables, chaining, setup/teardown and assertions.
import { plainProblem } from '../plain.js';
import { send } from '../http.js';
import { checkResponse } from '../assertions.js';
import { interpolate } from '../vars.js';
import { query } from '../jsonpath.js';
import { truncate, categorize } from '../util.js';
import { SafetyError } from '../safety.js';

// Captured values are treated as secrets unless the test lists them in extractPublic (e.g. ids).
function maskCaptured(test, name, value, redactor) {
  if ((test.extractPublic || []).includes(name)) return;
  // Numbers are left visible: masking "1234" would also mask timings and counts in the report.
  if (typeof value === 'string') redactor.add(value);
}

export async function runApiSuite(suite, ctx) {
  const { config, redactor, log } = ctx;
  ctx.sharedVars ??= {};
  ctx.runWarnings ??= [];
  const vars = { baseUrl: config.baseUrl, ...(config.vars || {}), ...(suite.vars || {}), ...ctx.sharedVars };
  const results = [];
  // setup -> tests -> teardown. If setup fails, tests are skipped; teardown always runs.
  const all = [
    ...(suite.setup || []).map((t) => ({ ...t, phase: 'setup' })),
    ...(suite.tests || []),
    ...(suite.teardown || []).map((t) => ({ ...t, phase: 'teardown' })),
  ];
  let setupFailed = false;
  const byName = new Map();
  for (const test of all) {
    if (ctx.signal?.aborted) break;
    const warnings = [];
    const entry = { suite: suite.name, name: test.name || test.request?.url || '(unnamed)', passed: false, skipped: false, failures: [], warnings };
    if (test.phase) entry.phase = test.phase;
    if (test.expect?.maxMs !== undefined) entry.budgetMs = Number(test.expect.maxMs);
    const base = test.dependsOn ? byName.get(test.dependsOn) : null;
    const baseMissing = test.dependsOn && (!base || base.skipped || [404, 405].includes(base.status) || (!base.passed && base.status == null));
    if (test.skip || (setupFailed && !test.phase) || baseMissing) {
      entry.skipped = true;
      entry.reason = test.skip ? (typeof test.skip === 'string' ? test.skip : 'marked skip')
        : setupFailed && !test.phase ? 'skipped because setup failed'
          : `skipped because "${test.dependsOn}" did not reach a working endpoint`;
      results.push(entry);
      log(`  SKIP  API  ${entry.name}  (${entry.reason})`);
      byName.set(entry.name, entry);
      continue;
    }
    if (test.untranslated?.length) warnings.push(`${test.untranslated.length} Postman script line(s) were not translated and need review.`);
    const req = interpolate(test.request || {}, vars, redactor, warnings);
    if (req.url && !/^https?:\/\//i.test(req.url)) req.url = `${vars.baseUrl || ''}${req.url}`;
    entry.method = String(req.method || 'GET').toUpperCase();
    entry.url = redactor.redact(String(req.url || ''));
    const attempts = Math.max(1, Math.min(5, Number(test.retries ?? 0) + 1) || 1);
    let res;
    for (let a = 1; a <= attempts; a++) {
      try {
        if (!req.url) throw new Error('request.url is missing');
        res = await send(req, { allowedHosts: config.allowedHosts, timeoutMs: test.timeoutMs || config.timeoutMs || 15000 });
        let expect = test.expect;
        if (String(req.method || 'GET').toUpperCase() === 'HEAD' && expect) {
          // HEAD responses have no body; only status, headers and timing can be checked.
          const { body, schema, bodyContains, ...rest } = expect;
          expect = rest;
        }
        entry.failures = checkResponse(expect, res);
        if (res.truncated) warnings.push('Response was larger than 5 MB and was cut off; JSON checks were not run.');
      } catch (e) {
        res = undefined;
        if (e instanceof SafetyError) entry.failures = [`blocked by safety rules: ${e.message}`];
        else entry.failures = [`request failed: ${e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message}`];
      }
      entry.attempts = a;
      if (!entry.failures.length) break;
    }
    if (res) {
      entry.status = res.status;
      entry.ms = res.ms;
      entry.size = res.size;
      // Extract first so captured tokens are registered as secrets before anything is stored.
      for (const [name, path] of Object.entries(test.extract || {})) {
        try {
          const r = res.json !== undefined ? query(res.json, path) : { found: false };
          if (r.found) {
            vars[name] = r.value;
            ctx.sharedVars[name] = r.value;
            maskCaptured(test, name, r.value, redactor);
          } else entry.failures.push(`extract ${name}: ${path} not found`);
        } catch (e) {
          entry.failures.push(`extract ${name}: ${e.message}`);
        }
      }
      entry.responseSnippet = redactor.redact(truncate(res.text, 1500));
      entry.responseHeaders = redactor.redact(res.headers);
    }
    entry.passed = entry.failures.length === 0;
    if (entry.passed && entry.attempts > 1) entry.flaky = true;
    entry.failures = redactor.redact(entry.failures);
    if (!entry.passed) entry.category = /^blocked by safety/.test(entry.failures[0]) ? 'test' : categorize(entry.failures[0]);
    if (test.phase === 'setup' && !entry.passed) setupFailed = true;
    ctx.runWarnings.push(...warnings.filter((w) => /not set|not defined/.test(w)).map((w) => `${suite.name} / ${entry.name}: ${w}`));
    results.push(entry);
    byName.set(entry.name, entry);
    const walled = entry.status === 401 || entry.status === 403;
    // Quick mode without a token: a login wall is skipped, not failed (the runner leaves it out of the score).
    const label = ctx.loginAsSkip && walled && (!entry.passed || /^fuzz /.test(entry.name)) ? 'SKIP' : entry.passed ? 'PASS' : 'FAIL';
    log(`  ${label}  API  ${entry.method} ${entry.url}  ${entry.status ?? '-'}  ${entry.ms ?? '-'}ms  ${entry.name}${walled ? '  (asked for a login)' : ''}`);
    if (label === 'FAIL' && entry.failures?.[0]) log(`        ${plainProblem(String(entry.failures[0]).split('\n')[0]).slice(0, 200)}`);
  }
  return results;
}
