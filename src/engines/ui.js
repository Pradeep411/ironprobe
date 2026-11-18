// UI engine: Playwright across browsers x devices. Each test and each page check runs in its own
// fresh browser context (no shared cookies/cache). Every navigation is checked against allowedHosts.
// Per-page checks: Web Vitals, axe-core accessibility, visual diff, console errors, failed requests.
import { plainProblem } from '../plain.js';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { assertAllowed, isHostAllowed, SafetyError, safeRegex, clampRetries } from '../safety.js';
import { interpolate } from '../vars.js';
import { slug, round, categorize } from '../util.js';
import { checkResponse } from '../assertions.js';
import { guardContext } from '../browser-guard.js';
import { startGuardProxy, proxyLaunchOptions } from '../guard-proxy.js';

const require = createRequire(import.meta.url);
export const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const STEP_TIMEOUT = 10000;
const DEFAULT_BUDGETS = { LCP: 2500, CLS: 0.1, FCP: 1800, TTFB: 800 };
export const STEP_ACTIONS = new Set(['goto', 'reload', 'request', 'click', 'fill', 'press', 'select', 'check', 'hover', 'waitFor', 'wait',
  'expectVisible', 'expectHidden', 'expectText', 'expectUrl', 'expectTitle', 'screenshot']);

// Network presets (Chromium applies throughput limits via DevTools; other engines get latency only via routing).
export const NETWORK_PRESETS = {
  '3g-india': { latency: 300, download: (750 * 1024) / 8, upload: (250 * 1024) / 8 },
  'slow-4g': { latency: 150, download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8 },
  '4g': { latency: 40, download: (9 * 1024 * 1024) / 8, upload: (3 * 1024 * 1024) / 8 },
  offline: { offline: true },
};

const VITALS_INIT = `(() => {
  window.__ironprobe = { lcp: null, cls: 0 };
  try {
    new PerformanceObserver((list) => { const e = list.getEntries(); const last = e[e.length - 1]; if (last) window.__ironprobe.lcp = last.startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { window.__ironprobe.lcpUnsupported = true; }
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__ironprobe.cls += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
  } catch (e) { window.__ironprobe.clsUnsupported = true; }
})();`;

export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error('Playwright is not installed. Run: npm i -D playwright && npx playwright install   (or run "ironprobe doctor")');
  }
}

export function contextOptions(pw, deviceName, browserName) {
  if (!deviceName || deviceName === 'Desktop') return { viewport: { width: 1366, height: 900 } };
  const d = pw.devices[deviceName];
  if (!d) throw new Error(`Unknown device "${deviceName}". Use a Playwright device name, e.g. "iPhone 15", "Pixel 7", "iPad Pro 11".`);
  const opts = { ...d };
  delete opts.defaultBrowserType;
  if (browserName === 'firefox') delete opts.isMobile; // not supported by Firefox
  return opts;
}

async function pool(items, size, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  const settled = await Promise.allSettled(runners);
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) throw failed.reason;
}

// True when IronProbe's own proxy refused this URL (e.g. a file on a private network address).
export function blockedByProxy(ctx, url) {
  try {
    return Boolean(url) && Boolean(ctx?.proxyBlocked?.has(new URL(url).host));
  } catch {
    return false;
  }
}

function attachListeners(page, sink, ctx) {
  page.on('console', (msg) => {
    // Resources IronProbe blocked on purpose are reported as notes, not as app errors.
    if (msg.type() !== 'error' || /ERR_BLOCKED_BY_CLIENT/.test(msg.text())) return;
    if (blockedByProxy(ctx, msg.location()?.url)) return;
    sink.console.push(msg.text().slice(0, 500));
  });
  page.on('pageerror', (err) => sink.console.push(`Uncaught: ${String(err.message).slice(0, 500)}`));
  page.on('requestfailed', (req) => {
    if (blockedByProxy(ctx, req.url())) return;
    if (!/ERR_BLOCKED_BY_CLIENT/.test(String(req.failure()?.errorText))) sink.network.push(`${req.method()} ${req.url().slice(0, 200)} failed: ${req.failure()?.errorText}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) sink.network.push(`${res.request().method()} ${res.url().slice(0, 200)} -> ${res.status()}`);
  });
}

function isOwnExtension(url, extra) {
  return Boolean(extra?.extensionId) && url.startsWith(`chrome-extension://${extra.extensionId}/`);
}

function resolveUrl(target, ctx, extra) {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `${ctx.config.baseUrl}${target}`;
  if (isOwnExtension(url, extra)) return url;
  assertAllowed(url, ctx.config.allowedHosts);
  return url;
}

// Every request the browser makes (navigations, redirects, fetch/XHR, images, scripts) is checked.
// Off-list navigations fail the test; off-list sub-resources are blocked unless listed in
// ui.allowAssetHosts (e.g. a font CDN) and are reported as notes.
async function guardRequests(context, ctx, extra, blocked, assetNotes) {
  await guardContext(context, {
    allowedHosts: ctx.config.allowedHosts,
    assetHosts: ctx.config.ui?.allowAssetHosts || [],
    blockHosts: ctx.config.ui?.blockHosts || [],
    isExempt: (url) => isOwnExtension(url, extra),
    onBlocked: ({ url, isNav }) => {
      if (isNav) blocked.push(url.slice(0, 200));
      else if (assetNotes.length < 20) assetNotes.push(url.slice(0, 200));
    },
  });
}

// One allow-list proxy per browser: it checks every connection, including redirect hops.
export function startProxy(ctx) {
  ctx.proxyBlocked ??= new Set();
  return startGuardProxy({
    allowedHosts: ctx.config.allowedHosts,
    assetHosts: ctx.config.ui?.allowAssetHosts || [],
    onBlocked: ({ url }) => {
      let host = '';
      try {
        host = new URL(url).host;
      } catch {
        return;
      }
      if (!ctx.proxyBlocked.has(host)) {
        ctx.proxyBlocked.add(host);
        ctx.runWarnings?.push(`IronProbe blocked files from ${host} (a private or unlisted address), so they did not load during the test. If that is your own server, test with a config file that lists it in allowedHosts.`);
      }
    },
  });
}

async function applyNetwork(context, page, browserName, preset) {
  if (!preset) return;
  const p = NETWORK_PRESETS[preset];
  if (!p) throw new Error(`Unknown network preset "${preset}" (use ${Object.keys(NETWORK_PRESETS).join(', ')}).`);
  if (p.offline) {
    await context.setOffline(true);
    return;
  }
  if (browserName === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: p.latency, downloadThroughput: p.download, uploadThroughput: p.upload });
  }
}

async function runSteps(page, steps, ctx, combo, artifacts, extra) {
  const vars = { baseUrl: ctx.config.baseUrl, ...(ctx.config.vars || {}), ...(ctx.sharedVars || {}), ...(extra?.extensionId ? { extensionId: extra.extensionId } : {}) };
  for (const [index, rawStep] of steps.entries()) {
    const step = interpolate(rawStep, vars, ctx.redactor, ctx.runWarnings);
    const [action, arg] = Object.entries(step)[0];
    const label = `step ${index + 1} (${action})`;
    try {
      switch (action) {
        case 'goto':
          await page.goto(resolveUrl(arg, ctx, extra), { waitUntil: 'load', timeout: ctx.navTimeout ?? 30000 });
          break;
        case 'reload':
          await page.reload({ waitUntil: 'load', timeout: ctx.navTimeout ?? 30000 });
          break;
        case 'request': {
          // Outcome check: call the API (sharing the page's cookies) and assert the real state changed.
          const url = resolveUrl(arg.url, ctx, extra);
          const t0 = Date.now();
          const res = await page.request.fetch(url, { method: arg.method || 'GET', headers: arg.headers, data: arg.json, maxRedirects: 0, timeout: STEP_TIMEOUT });
          const text = await res.text();
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          const problems = checkResponse(arg.expect || { status: 200 }, { status: res.status(), ms: Date.now() - t0, headers: res.headers(), text, json });
          if (problems.length) throw new Error(`API outcome check failed: ${problems.join('; ')}`);
          break;
        }
        case 'click':
          await page.locator(arg).first().click({ timeout: STEP_TIMEOUT });
          break;
        case 'fill':
          await page.locator(arg.selector).first().fill(String(arg.value ?? ''), { timeout: STEP_TIMEOUT });
          break;
        case 'press':
          if (typeof arg === 'string') await page.keyboard.press(arg);
          else await page.locator(arg.selector).first().press(arg.key, { timeout: STEP_TIMEOUT });
          break;
        case 'select':
          await page.locator(arg.selector).first().selectOption(String(arg.value), { timeout: STEP_TIMEOUT });
          break;
        case 'check':
          await page.locator(arg).first().check({ timeout: STEP_TIMEOUT });
          break;
        case 'hover':
          await page.locator(arg).first().hover({ timeout: STEP_TIMEOUT });
          break;
        case 'waitFor':
        case 'expectVisible':
          await page.locator(arg).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
          break;
        case 'expectHidden':
          await page.locator(arg).first().waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
          break;
        case 'wait':
          await page.waitForTimeout(Math.min(Number(arg) || 0, 10000));
          break;
        case 'expectText': {
          const loc = page.locator(arg.selector || 'body').first();
          const deadline = Date.now() + STEP_TIMEOUT;
          let text = '';
          while (Date.now() < deadline) {
            text = (await loc.innerText({ timeout: 2000 }).catch(() => '')) || '';
            if (text.includes(String(arg.text))) break;
            await page.waitForTimeout(200);
          }
          if (!text.includes(String(arg.text))) throw new Error(`text "${arg.text}" not found in ${arg.selector || 'body'}`);
          break;
        }
        case 'expectUrl': {
          const re = safeRegex(String(arg));
          if (!re.test(page.url())) throw new Error(`URL ${page.url()} does not match ${arg}`);
          break;
        }
        case 'expectTitle': {
          const title = await page.title();
          if (!title.includes(String(arg))) throw new Error(`title "${title}" does not include "${arg}"`);
          break;
        }
        case 'screenshot': {
          const file = path.join(artifacts, `${slug(combo)}-${slug(arg || `step-${index + 1}`)}.png`);
          await page.screenshot({ path: file, fullPage: true });
          break;
        }
        default:
          throw new Error(`unknown action "${action}"`);
      }
    } catch (e) {
      const msg = e instanceof SafetyError ? `blocked by safety rules: ${e.message}` : String(e.message).split('\n')[0];
      return { ok: false, failure: `${label}: ${msg}` };
    }
  }
  return { ok: true };
}

async function collectVitals(page) {
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const s = window.__ironprobe || {};
    return {
      TTFB: nav ? nav.responseStart - nav.startTime : null,
      FCP: fcp ? fcp.startTime : null,
      LCP: s.lcpUnsupported ? null : s.lcp,
      CLS: s.clsUnsupported ? null : s.cls,
      load: nav ? nav.loadEventEnd - nav.startTime : null,
    };
  });
}

const IMPACTS = new Set(['critical', 'serious', 'moderate', 'minor']);

// axe runs inside the tested page, so the page could tamper with it. Validate and coerce every field.
export async function runAxe(page, tags = AXE_TAGS) {
  await page.evaluate(AXE_SOURCE);
  const raw = await page.evaluate(async (t) => {
    // eslint-disable-next-line no-undef
    // preload: false stops axe from re-fetching stylesheets, which caused false console errors.
    const r = await axe.run(document, { runOnly: { type: 'tag', values: t }, resultTypes: ['violations'], preload: false });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }));
  }, tags);
  if (!Array.isArray(raw)) throw new Error('accessibility scan returned an unexpected result');
  return raw.slice(0, 200).map((v) => ({
    id: String(v?.id ?? '').slice(0, 80),
    impact: IMPACTS.has(v?.impact) ? v.impact : 'minor',
    help: String(v?.help ?? '').slice(0, 300),
    helpUrl: /^https:\/\/dequeuniversity\.com\//.test(String(v?.helpUrl)) ? String(v.helpUrl) : '',
    nodes: Number.isFinite(Number(v?.nodes)) ? Math.max(0, Math.floor(Number(v.nodes))) : 0,
    sample: String(v?.sample ?? '').slice(0, 200),
  }));
}

// A change fails when more than maxDiffPixels pixels differ (default 25), or, if a ratio threshold
// is configured, when the changed share of pixels is above it. Anti-aliasing noise is ignored.
function compareVisual(currentFile, baselineFile, diffFile, { ratio: threshold, maxDiffPixels }, update) {
  if (update || !fs.existsSync(baselineFile)) {
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.copyFileSync(currentFile, baselineFile);
    return { status: update ? 'updated-baseline' : 'new-baseline', diffRatio: 0 };
  }
  const a = PNG.sync.read(fs.readFileSync(baselineFile));
  const b = PNG.sync.read(fs.readFileSync(currentFile));
  if (a.width !== b.width || a.height !== b.height) {
    return { status: 'changed', diffRatio: 1, note: `size changed ${a.width}x${a.height} -> ${b.width}x${b.height}` };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const ratio = changed / (a.width * a.height);
  const failed = threshold != null ? ratio > threshold : changed > maxDiffPixels;
  if (failed) {
    fs.writeFileSync(diffFile, PNG.sync.write(diff));
    return { status: 'changed', diffRatio: round(ratio, 5), changedPixels: changed, diff: path.basename(diffFile) };
  }
  return { status: 'match', diffRatio: round(ratio, 5), changedPixels: changed };
}

// Opens one browser per combo. Returns newContext() so every test gets a clean context.
async function openTarget(pw, browserName, device, uiCfg, ctx) {
  const browserType = pw[browserName];
  const base = {
    ...contextOptions(pw, device, browserName),
    ...(uiCfg.locale ? { locale: uiCfg.locale } : {}),
    ...(uiCfg.timezone ? { timezoneId: uiCfg.timezone } : {}),
    ...(uiCfg.geolocation ? { geolocation: uiCfg.geolocation, permissions: ['geolocation'] } : {}),
    ...(uiCfg.storageState ? { storageState: path.resolve(ctx.configDir, uiCfg.storageState) } : {}),
  };
  if (uiCfg.extension) {
    if (browserName !== 'chromium') return { skip: 'extensions are tested in Chromium only' };
    const extPath = path.resolve(ctx.configDir, uiCfg.extension);
    if (!fs.existsSync(path.join(extPath, 'manifest.json'))) throw new Error(`No manifest.json in extension folder ${extPath}`);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ironprobe-ext-'));
    const cleanup = () => fs.rmSync(userDataDir, { recursive: true, force: true });
    const proxy = await startProxy(ctx);
    let context;
    try {
      const { storageState, ...persistentOpts } = base; // persistent contexts do not take storageState
      const lo = proxyLaunchOptions('chromium', proxy);
      context = await browserType.launchPersistentContext(userDataDir, {
        ...persistentOpts,
        ...lo,
        channel: 'chromium',
        headless: !ctx.headed,
        args: [...lo.args, `--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
      });
    } catch (e) {
      cleanup();
      await proxy.close();
      throw e;
    }
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
    const extensionId = sw ? new URL(sw.url()).host : null;
    // Extensions need the persistent profile, so tests share it (documented limitation).
    return { shared: true, blocked: [], assetNotes: [], newContext: async () => context, close: async () => { await context.close().catch(() => {}); cleanup(); await proxy.close(); }, extensionId };
  }
  let browser;
  const proxy = await startProxy(ctx);
  try {
    browser = await browserType.launch({ headless: !ctx.headed, ...proxyLaunchOptions(browserName, proxy) });
  } catch (e) {
    await proxy.close();
    const missing = /Executable doesn't exist|browserType\.launch/i.test(String(e.message));
    return { skip: missing ? `${browserName} is not installed (run: npx playwright install ${browserName})` : `${browserName} failed to start: ${String(e.message).split('\n')[0]}` };
  }
  return { newContext: () => browser.newContext({ ...base, serviceWorkers: 'block' }), close: async () => { await browser.close().catch(() => {}); await proxy.close(); } };
}

export async function runUi(uiCfg, suites, ctx) {
  const pw = await loadPlaywright();
  const browsers = uiCfg.browsers || ['chromium'];
  const devices = uiCfg.devices || ['Desktop'];
  for (const b of browsers) if (!['chromium', 'firefox', 'webkit'].includes(b)) throw new Error(`Unknown browser "${b}" (use chromium, firefox, webkit).`);
  for (const d of devices) contextOptions(pw, d, 'chromium'); // fail fast on unknown device names
  if (uiCfg.network && !NETWORK_PRESETS[uiCfg.network]) throw new Error(`Unknown network preset "${uiCfg.network}" (use ${Object.keys(NETWORK_PRESETS).join(', ')}).`);
  const budgets = { ...DEFAULT_BUDGETS, ...(uiCfg.perf?.budgets || {}) };
  const artifacts = path.join(ctx.outDir, 'artifacts');
  const baselineDir = path.resolve(ctx.configDir, uiCfg.baselineDir || '.ironprobe/baselines');
  fs.mkdirSync(artifacts, { recursive: true });
  const combos = browsers.flatMap((b) => devices.map((d) => ({ browser: b, device: d })));
  const out = { tests: [], pages: [], skippedCombos: [] };
  const trace = uiCfg.trace !== false;

  await pool(combos, uiCfg.workers || 3, async ({ browser: browserName, device }) => {
    try {
      await runCombo(browserName, device);
    } catch (e) {
      // One broken browser/device combination must not discard the others.
      const message = String(e.message || e).split('\n')[0];
      out.tests.push({ suite: '(setup)', name: `Start ${browserName} ${device}`, browser: browserName, device, passed: false, failures: [message], category: 'infrastructure', durationMs: 0 });
      ctx.log(`  FAIL  UI   ${browserName} ${device}: ${message}`);
    }
  });

  async function runCombo(browserName, device) {
    const combo = `${browserName} ${device}`;
    const target = await openTarget(pw, browserName, device, uiCfg, ctx);
    if (target.skip) {
      out.skippedCombos.push({ browser: browserName, device, reason: target.skip });
      ctx.log(`  SKIP  UI   ${combo}: ${target.skip}`);
      return;
    }
    const extra = { extensionId: target.extensionId };

    // Runs fn with a fresh context + page; always closes them.
    const withPage = async (fn) => {
      const context = await target.newContext();
      const blocked = [];
      const assetNotes = [];
      if (!context.__ironprobeGuarded) {
        await guardRequests(context, ctx, extra, target.shared ? target.blocked : blocked, target.shared ? target.assetNotes : assetNotes);
        context.__ironprobeGuarded = true;
      }
      if (target.shared) {
        target.blocked.length = 0;
        target.assetNotes.length = 0;
      }
      const page = await context.newPage();
      try {
        await applyNetwork(context, page, browserName, uiCfg.network);
        return await fn(page, context, target.shared ? target.blocked : blocked, target.shared ? target.assetNotes : assetNotes);
      } finally {
        await page.close().catch(() => {});
        if (!target.shared) await context.close().catch(() => {});
      }
    };

    try {
      for (const suite of suites) {
        for (const test of suite.tests || []) {
          if (ctx.signal?.aborted) break;
          const maxAttempts = 1 + clampRetries(test.retries ?? uiCfg.retries, 1);
          const started = Date.now();
          const firstFailures = [];
          let last;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const isLast = attempt === maxAttempts;
            last = await withPage(async (page, context, blocked, assetNotes) => {
              const sink = { console: [], network: [] };
              attachListeners(page, sink, ctx);
              const tracing = trace && isLast && !target.shared;
              if (tracing) await context.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
              const r = await runSteps(page, test.steps || [], ctx, combo, artifacts, extra);
              if (blocked.length) {
                r.ok = false;
                r.failure = `navigation to a host outside allowedHosts was blocked: ${blocked[0]}`;
              }
              const res = { r, sink, attempt, assetNotes: [...assetNotes] };
              if (!r.ok) {
                const shot = path.join(artifacts, `${slug(combo)}-${slug(test.name)}-failure.png`);
                await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
                if (fs.existsSync(shot)) res.screenshot = path.basename(shot);
              }
              if (tracing) {
                const file = path.join(artifacts, `${slug(combo)}-${slug(test.name)}-trace.zip`);
                if (!r.ok) {
                  await context.tracing.stop({ path: file }).catch(() => {});
                  if (fs.existsSync(file)) res.trace = path.basename(file);
                } else {
                  await context.tracing.stop().catch(() => {});
                }
              }
              return res;
            });
            if (last.r.ok) break;
            firstFailures.push(last.r.failure);
          }
          const { r, sink } = last;
          const entry = {
            suite: suite.name, name: test.name, browser: browserName, device,
            passed: r.ok, failures: r.ok ? [] : [r.failure], durationMs: Date.now() - started, attempts: last.attempt,
            console: sink.console.slice(0, 20), network: sink.network.slice(0, 20),
          };
          if (last.assetNotes.length) entry.blockedAssets = last.assetNotes;
          if (r.ok && last.attempt > 1) {
            entry.flaky = true;
            entry.flakyReason = firstFailures[0];
          }
          if (test.failOnConsoleError && sink.console.length) {
            entry.passed = false;
            entry.failures.push(`console errors: ${sink.console.length}`);
          }
          if (!entry.passed) {
            entry.category = categorize(entry.failures[0]);
            if (last.screenshot) entry.screenshot = last.screenshot;
            if (last.trace) entry.trace = last.trace;
          }
          out.tests.push(ctx.redactor.redact(entry));
          ctx.log(`  ${entry.passed ? 'PASS' : 'FAIL'}  UI   ${combo}  ${test.name}${entry.flaky ? ' (flaky)' : ''}`);
          if (!entry.passed && entry.failures?.length) ctx.log(`        ${entry.failures.map((f) => plainProblem(String(f).split('\n')[0])).join(' ').slice(0, 240)}`);
        }
      }

      const pages = [...new Set([...(uiCfg.pages || []), ...suites.flatMap((s) => s.pages || [])])];
      for (const p of pages) {
        if (ctx.signal?.aborted) break;
        const entry = { url: '', browser: browserName, device, failures: [] };
        try {
          const vars = { baseUrl: ctx.config.baseUrl, ...(ctx.config.vars || {}), ...(ctx.sharedVars || {}), ...(extra.extensionId ? { extensionId: extra.extensionId } : {}) };
          entry.url = resolveUrl(interpolate(String(p), vars, ctx.redactor, ctx.runWarnings), ctx, extra);
        } catch (e) {
          entry.url = String(p);
          entry.failures.push(`blocked by safety rules: ${e.message}`);
          entry.passed = false;
          out.pages.push(entry);
          continue;
        }
        await withPage(async (page, context, blocked, assetNotes) => {
          await page.addInitScript(VITALS_INIT);
          const sink = { console: [], network: [] };
          attachListeners(page, sink, ctx);
          try {
            await page.goto(entry.url, { waitUntil: 'load', timeout: ctx.navTimeout ?? 30000 });
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            if (uiCfg.perf !== false) {
              const v = await collectVitals(page);
              // Page-controlled values: keep only finite numbers.
              entry.vitals = Object.fromEntries(['TTFB', 'FCP', 'LCP', 'CLS', 'load'].map((k) => {
                const n = Number(v?.[k]);
                return [k, v?.[k] == null || !Number.isFinite(n) ? null : round(n, k === 'CLS' ? 3 : 0)];
              }));
              for (const [k, limit] of Object.entries(budgets)) {
                if (entry.vitals[k] != null && entry.vitals[k] > limit) entry.failures.push(`${k} ${entry.vitals[k]} over budget ${limit}`);
              }
            }
            if (uiCfg.a11y !== false) {
              entry.a11y = await runAxe(page);
              const blocking = entry.a11y.filter((v) => ['critical', 'serious'].includes(v.impact));
              if (blocking.length) entry.failures.push(`${blocking.length} critical/serious accessibility issue(s): ${[...new Set(blocking.map((v) => v.id))].join(', ')}`);
            }
            if (uiCfg.visual && (!uiCfg.visualPages || uiCfg.visualPages.includes(p))) {
              const u = new URL(entry.url);
              const qhash = u.search ? `-${crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 8)}` : '';
              const name = `${slug(browserName)}-${slug(device)}-${slug(u.pathname)}${qhash}.png`;
              const current = path.join(artifacts, `current-${name}`);
              const mask = (uiCfg.visualMask || []).map((sel) => page.locator(String(sel)));
              await page.screenshot({ path: current, fullPage: uiCfg.visualFullPage !== false, animations: 'disabled', caret: 'hide', mask });
              const limits = { ratio: uiCfg.visualThreshold ?? null, maxDiffPixels: Number(uiCfg.visualMaxDiffPixels ?? 25) };
              entry.visual = compareVisual(current, path.join(baselineDir, name), path.join(artifacts, `diff-${name}`), limits, ctx.updateBaselines);
              entry.visual.current = path.basename(current);
              if (entry.visual.status === 'changed' && uiCfg.visualInfoOnly) {
                // Quick mode: a new look is news, not a failure. Report it once and keep the new look.
                fs.copyFileSync(current, path.join(baselineDir, name));
                entry.visual.status = 'changed-accepted';
                entry.notes = [...(entry.notes || []), 'Looks different from last time (saved as the new look).'];
              }
              if (entry.visual.status === 'changed') entry.failures.push(entry.visual.note ? `visual change: ${entry.visual.note}` : `visual change: ${entry.visual.changedPixels} pixels (${round(entry.visual.diffRatio * 100, 3)}%)`);
            }
          } catch (e) {
            entry.failures.push(`page check failed: ${String(e.message).split('\n')[0]}`);
          }
          if (blocked.length) entry.failures.push(`navigation to a host outside allowedHosts was blocked: ${blocked[0]}`);
          if (assetNotes.length) entry.blockedAssets = [...assetNotes];
          entry.console = sink.console.slice(0, 20);
          entry.network = sink.network.slice(0, 20);
        });
        if (uiCfg.failOnConsoleError && entry.console?.length) entry.failures.push(`console errors: ${entry.console.length}`);
        entry.passed = entry.failures.length === 0;
        if (!entry.passed) entry.category = categorize(entry.failures[0]);
        out.pages.push(ctx.redactor.redact(entry));
        ctx.log(`  ${entry.passed ? 'PASS' : 'FAIL'}  PAGE ${combo}  ${p}`);
        if (!entry.passed && entry.failures?.length) ctx.log(`        ${entry.failures.map((f) => plainProblem(String(f).split('\n')[0])).join(' ').slice(0, 240)}`);
      }
    } finally {
      await target.close();
    }
  }

  // Deterministic order regardless of which worker finished first.
  const bi = (b) => browsers.indexOf(b);
  const di = (d) => devices.indexOf(d);
  const byCombo = (a, b) => bi(a.browser) - bi(b.browser) || di(a.device) - di(b.device);
  out.tests.sort(byCombo);
  out.pages.sort(byCombo);
  out.skippedCombos.sort(byCombo);
  return out;
}
