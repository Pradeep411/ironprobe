// Runs everything and always writes results.json, report.html, junit.xml and history.jsonl,
// even if one engine crashes (the crash is recorded as a failed "engine error").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ConfigError } from './config.js';
import { Redactor, validateLoadConfig, SafetyError } from './safety.js';
import { runApiSuite } from './engines/api.js';
import { runUi } from './engines/ui.js';
import { runLoad } from './engines/load.js';
import { runCrawl } from './engines/crawl.js';
import { renderHtml } from './report/html.js';
import { renderJunit } from './report/junit.js';
import { VERSION, round } from './util.js';
import { scanPaths } from './secrets.js';
import { healthScore } from './score.js';

export const ENGINES = ['api', 'ui', 'crawl', 'load'];

export async function run({ configPath, only = ENGINES, outDir, headed = false, updateBaselines = false, log = console.log, extraSecrets = [], loginAsSkip = false, extraVars = {}, signal, navTimeout, fingerprint }) {
  const loaded = loadConfig(configPath);
  const { config, configDir } = loaded;
  const out = path.resolve(outDir || path.join(configDir, config.output || 'ironprobe-report'));
  fs.mkdirSync(out, { recursive: true });
  const redactor = new Redactor();
  for (const name of config.secretEnv || []) if (process.env[name]) redactor.add(process.env[name]);
  for (const secret of [...extraSecrets, ...(loaded.secrets || [])]) if (secret && String(secret).length >= 4) redactor.add(String(secret));
  const ctx = { config, configDir, outDir: out, redactor, log, headed, updateBaselines, sharedVars: { ...extraVars }, runWarnings: [], signal, navTimeout, loginAsSkip };
  const loadCfg = only.includes('load') ? validateLoadConfig(config.load, config) : null;

  if (only.includes('ui') && config.ui) {
    // Fail fast (exit 2) on device names Playwright does not know.
    let pw = null;
    try {
      pw = await import('playwright');
    } catch {
      /* reported later as a missing dependency */
    }
    for (const d of config.ui.devices || []) {
      if (pw && d !== 'Desktop' && !pw.devices[d]) throw new ConfigError(`Unknown device "${d}" in ui.devices. Use Desktop or a Playwright device name such as "iPhone 15", "Pixel 7", "iPad Pro 11".`);
    }
  }

  const started = Date.now();
  const results = {
    meta: {
      name: config.name, version: VERSION, startedAt: new Date(started).toISOString(), node: process.version,
      platform: `${os.platform()} ${os.arch()}`, budgets: { LCP: 2500, CLS: 0.1, FCP: 1800, TTFB: 800, ...(config.ui?.perf?.budgets || {}) },
      engines: only,
    },
    api: [], ui: { tests: [], pages: [], skippedCombos: [] }, crawl: null, load: null, engineErrors: [], warnings: [...loaded.warnings],
  };

  log(`IronProbe ${VERSION}: ${config.name}`);
  const leaks = scanPaths([configDir], { skipDirs: [path.basename(out)] });
  for (const f of leaks) results.warnings.push(`Possible hard-coded secret (${f.kind}) in ${path.relative(configDir, f.file)}:${f.line}. Use {{env.NAME}} instead.`);
  if (leaks.length) log(`! ${leaks.length} possible hard-coded secret(s) in test files. See the report warnings.`);

  const guard = async (engine, fn) => {
    try {
      await fn();
    } catch (e) {
      // A load test aimed at an off-list host is refused before any request: treat it like a
      // config error (exit 2), not a failed run.
      if (engine === 'load' && e instanceof SafetyError) throw e;
      const message = String(e.message || e).split('\n')[0];
      const safe = redactor.redact(message);
      results.engineErrors.push({ engine, message: safe, passed: false, failures: [safe], category: 'infrastructure' });
      log(`  ERROR ${engine}: ${safe}`);
    }
  };

  if (only.includes('api') && loaded.apiSuites.length) {
    log('API');
    await guard('api', async () => {
      for (const s of loaded.apiSuites) results.api.push(...(await runApiSuite(s, ctx)));
    });
  }
  if (only.includes('ui') && config.ui) {
    log('UI');
    await guard('ui', async () => {
      results.ui = await runUi(config.ui, loaded.uiSuites, ctx);
    });
  }
  if (only.includes('crawl') && config.crawl) {
    log('Crawl');
    await guard('crawl', async () => {
      results.crawl = await runCrawl(config.crawl, ctx);
    });
  }
  if (loadCfg) {
    log('Load');
    await guard('load', async () => {
      results.load = await runLoad(loadCfg, ctx);
    });
  }

  if (loginAsSkip) {
    let loginSkips = 0;
    // Quick mode without a token: a 401/403 means "needs a login", not a bug, so it is skipped
    // (and left out of the score) with a clear way forward.
    for (const x of results.api) {
      // Also covers edge-case (fuzz) checks that "passed" only because a login wall answered.
      if (!x.skipped && (x.status === 401 || x.status === 403) && (!x.passed || /^fuzz /.test(x.name))) {
        x.passed = false;
        x.skipped = true;
        x.category = 'login';
        const isLogin = String(x.method).toUpperCase() !== 'GET' && /log ?in|sign ?in|auth|token|session/i.test(`${x.name} ${x.url}`);
        x.reason = isLogin ? 'The login request in your file was refused. Check the username and password it uses.' : 'Needs a login: add an API token and run again.';
        loginSkips++;
      }
    }
    if (loginSkips) log(`  SKIP  ${loginSkips} API check(s) above need a login, so they are not counted. Add an API token to include them.`);
  }
  if (signal?.aborted) results.warnings.push('Stopped early. These results cover only the checks that finished.');
  if (fingerprint) results.meta.fingerprint = fingerprint;
  results.meta.finishedAt = new Date().toISOString();
  results.meta.durationMs = Date.now() - started;
  const all = [...results.api, ...results.ui.tests, ...results.ui.pages, ...(results.crawl?.pages || []), ...(results.load ? [results.load] : []), ...results.engineErrors];
  const counted = all.filter((x) => !x.skipped);
  const failed = counted.filter((x) => !x.passed).length;
  const skippedCombos = results.ui.skippedCombos.length;
  results.summary = {
    total: all.length, passed: counted.length - failed, failed,
    skipped: all.length - counted.length, skippedCombos,
    passRate: counted.length ? round(((counted.length - failed) / counted.length) * 100, 1) : 0,
    nothingRan: counted.length === 0,
    uiNothingRan: Boolean(only.includes('ui') && config.ui && skippedCombos && !results.ui.tests.length && !results.ui.pages.length),
  };
  results.summary.stopped = Boolean(signal?.aborted); // a partial run never gets a score
  results.health = healthScore(results);
  results.summary.score = results.health.score;
  if (skippedCombos) results.warnings.push(`${skippedCombos} browser/device combination(s) did not run (browser not installed). Run "ironprobe doctor".`);
  if (results.summary.nothingRan) results.warnings.push('No checks ran. Check the config and the --only option.');
  if (results.summary.uiNothingRan) results.warnings.push('No browser could run, so no UI checks ran. Run "ironprobe doctor".');
  results.warnings = [...new Set([...results.warnings, ...ctx.runWarnings])];

  // Mask every known secret anywhere in the results before writing to disk.
  Object.assign(results, redactor.redact(results));

  const historyFile = path.join(out, 'history.jsonl');
  // Trends only compare like with like: same kind of run (fingerprint), never stopped runs.
  const fp = results.meta.fingerprint || null;
  const history = (fs.existsSync(historyFile)
    ? fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : []).filter((h) => (h.fingerprint || null) === fp && !h.stopped);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(out, 'report.html'), renderHtml(results, history));
  fs.writeFileSync(path.join(out, 'junit.xml'), renderJunit(results));
  if (!results.summary.nothingRan && !results.summary.stopped) {
    fs.appendFileSync(historyFile, `${JSON.stringify({ startedAt: results.meta.startedAt, passRate: results.summary.passRate, score: results.summary.score, failed, total: all.length, fingerprint: fp })}\n`);
  }
  const verdict = results.summary.nothingRan ? '✕ nothing ran' : failed ? `✕ ${failed} failed` : '✓ all passed';
  log(`\n${verdict}: ${results.summary.passed}/${counted.length} passed, ${results.summary.skipped} skipped${skippedCombos ? `, ${skippedCombos} browser combo(s) not run` : ''}, ${round(results.meta.durationMs / 1000, 1)} s`);
  if (results.summary.score != null) log(`Health score: ${results.summary.score}/100 (${results.health.label})`);
  log(`Report: ${path.join(out, 'report.html')}`);
  return { results, outDir: out };
}
