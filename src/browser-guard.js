// Network guard for every browser context IronProbe opens. Two layers:
// 1. This route guard checks the first hop of every request (page loads, fetch/XHR, scripts,
//    images, streams, WebSockets) and decides page-vs-file: off-list page loads fail the test,
//    off-list files are blocked unless listed in ui.allowAssetHosts.
// 2. The guard proxy (guard-proxy.js) sits under the whole browser and checks every connection,
//    so redirect hops, which the route guard cannot see, are checked as well.
// Requests continue in the browser itself, so throttling, offline mode and the browser's own
// local-network rules behave exactly as they would without IronProbe.
import { isHostAllowed } from './safety.js';

export async function guardContext(context, { allowedHosts, assetHosts = [], blockHosts = [], isExempt = () => false, onBlocked }) {
  // assetHosts ['*'] (quick mode): the page may load its own files from any host, as in a normal
  // visit; page loads, crawling and API calls stay limited to allowedHosts.
  const anyAsset = assetHosts.includes('*');
  const allowedFor = (url, isNav) =>
    isHostAllowed(url, allowedHosts) || (!isNav && (anyAsset ? /^(https?|wss?):/i.test(url) : isHostAllowed(url, assetHosts)));
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    try {
      if (!/^https?:/i.test(url) || isExempt(url)) return await route.continue();
      const isNav = req.isNavigationRequest();
      // Known analytics and ad hosts are skipped quietly, so tests do not count as real visits.
      if (!isNav && blockHosts.length && isHostAllowed(url, blockHosts)) return await route.abort('blockedbyclient');
      if (!allowedFor(url, isNav)) {
        onBlocked({ url, isNav });
        return await route.abort('blockedbyclient');
      }
      return await route.continue();
    } catch {
      await route.abort('failed').catch(() => {});
    }
  });

  // Redirect hops are not routed; the proxy stops off-list ones. Record them so the test fails
  // with a clear reason, and flag page loads that a redirect moved onto an asset-only host.
  const seen = new Set();
  const noteRedirect = (req) => {
    const url = req.url();
    if (!req.redirectedFrom() || !/^https?:/i.test(url) || isExempt(url) || seen.has(req)) return;
    const isNav = req.isNavigationRequest();
    if (!allowedFor(url, isNav)) {
      seen.add(req);
      onBlocked({ url, isNav, redirect: true });
    }
  };
  context.on('request', noteRedirect);
  context.on('requestfailed', noteRedirect);

  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket(/.*/, (ws) => {
      const httpUrl = ws.url().replace(/^ws/i, 'http');
      if (!allowedFor(httpUrl, false)) {
        onBlocked({ url: ws.url(), isNav: false });
        ws.close({ code: 1008, reason: 'blocked by IronProbe allowedHosts' }).catch?.(() => {});
        return;
      }
      ws.connectToServer();
    });
  }
}
