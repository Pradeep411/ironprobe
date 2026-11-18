// Crawl engine: same-site smoke crawl in Chromium. Finds broken pages, console errors and
// accessibility problems on every reachable page. Every request is checked against allowedHosts.
import { plainProblem } from '../plain.js';
import { assertAllowed, isHostAllowed, safeRegex, CRAWL_CAP } from '../safety.js';
import { loadPlaywright, runAxe, AXE_TAGS, startProxy, blockedByProxy } from './ui.js';
import { proxyLaunchOptions } from '../guard-proxy.js';
import { guardContext } from '../browser-guard.js';

export async function runCrawl(crawlCfg, ctx) {
  const pw = await loadPlaywright();
  const start = new URL(crawlCfg.start || '/', `${ctx.config.baseUrl}/`).toString();
  assertAllowed(start, ctx.config.allowedHosts);
  let origin = new URL(start).origin;
  const maxPages = Math.min(Math.floor(Number(crawlCfg.maxPages ?? 25)) || 25, CRAWL_CAP);
  const exclude = (crawlCfg.exclude || []).map((p) => safeRegex(p));
  let browser;
  const proxy = await startProxy(ctx);
  try {
    browser = await pw.chromium.launch({ headless: !ctx.headed, ...proxyLaunchOptions('chromium', proxy) });
  } catch (e) {
    await proxy.close();
    throw new Error(`Chromium could not start for the crawl. Run "npx playwright install chromium" (or "ironprobe doctor"). ${String(e.message).split('\n')[0]}`);
  }
  const queue = [start];
  const seen = new Set([start]);
  const results = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block' });
    let blockedNav = [];
    let blockedAssets = [];
    await guardContext(context, {
      allowedHosts: ctx.config.allowedHosts,
      assetHosts: ctx.config.ui?.allowAssetHosts || [],
      blockHosts: ctx.config.ui?.blockHosts || [],
      onBlocked: ({ url, isNav }) => {
        if (isNav) blockedNav.push(url.slice(0, 200));
        else if (blockedAssets.length < 20) blockedAssets.push(url.slice(0, 200));
      },
    });
    while (queue.length && results.length < maxPages && !ctx.signal?.aborted) {
      const url = queue.shift();
      blockedNav = [];
      blockedAssets = [];
      const page = await context.newPage();
      const consoleErrors = [];
      page.on('console', (m) => m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(m.text()) && !blockedByProxy(ctx, m.location()?.url) && consoleErrors.push(m.text().slice(0, 300)));
      page.on('pageerror', (e) => consoleErrors.push(`Uncaught: ${String(e.message).slice(0, 300)}`));
      const entry = { url, failures: [] };
      try {
        const res = await page.goto(url, { waitUntil: 'load', timeout: ctx.navTimeout ?? 30000 });
        entry.status = res?.status() ?? 0;
        if (entry.status >= 400) entry.failures.push(`HTTP ${entry.status}`);
        // The start page may redirect (example.com -> www.example.com). Follow the site there,
        // as long as the new host is one you allowed.
        if (!results.length && new URL(page.url()).origin !== origin && isHostAllowed(page.url(), ctx.config.allowedHosts)) {
          origin = new URL(page.url()).origin;
          seen.add(page.url());
        }
        if (new URL(page.url()).origin === origin) {
          if (crawlCfg.a11y !== false) {
            const v = await runAxe(page, AXE_TAGS);
            const blocking = v.filter((x) => x.impact === 'critical' || x.impact === 'serious');
            entry.a11yCritical = blocking.length;
            entry.a11yTotal = v.length;
            if (entry.a11yCritical && crawlCfg.a11yFail !== false) entry.failures.push(`${entry.a11yCritical} critical/serious accessibility issue(s): ${[...new Set(blocking.map((x) => x.id))].join(', ')}`);
          }
          const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href).slice(0, 500));
          for (const link of links) {
            let u;
            try {
              u = new URL(String(link));
            } catch {
              continue;
            }
            u.hash = '';
            const clean = u.toString();
            if (u.origin !== origin || !isHostAllowed(clean, ctx.config.allowedHosts)) continue;
            if (exclude.some((re) => re.test(clean)) || /\/(logout|log-out|signout|sign-out|delete|remove|unsubscribe)\b/i.test(u.pathname)) continue;
            if (!seen.has(clean) && seen.size < CRAWL_CAP * 10) {
              seen.add(clean);
              queue.push(clean);
            }
          }
        }
      } catch (e) {
        entry.failures.push(blockedNav.length
          ? `redirect or navigation to a host outside allowedHosts was blocked: ${blockedNav[0]}`
          : `load failed: ${String(e.message).split('\n')[0]}`);
      } finally {
        await page.close().catch(() => {});
      }
      entry.consoleErrors = consoleErrors.slice(0, 10);
      if (blockedAssets.length) entry.blockedAssets = [...blockedAssets];
      if (consoleErrors.length && crawlCfg.failOnConsoleError !== false) entry.failures.push(`${consoleErrors.length} console error(s)`);
      entry.passed = entry.failures.length === 0;
      results.push(ctx.redactor.redact(entry));
      ctx.log(`  ${entry.passed ? 'PASS' : 'FAIL'}  CRAWL ${new URL(url).pathname}  ${entry.status ?? '-'}`);
      if (!entry.passed && entry.failures?.length) ctx.log(`        ${entry.failures.map((f) => plainProblem(String(f).split('\n')[0])).join(' ').slice(0, 240)}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await proxy.close();
  }
  return { pages: results, discovered: seen.size, capped: seen.size > results.length };
}
