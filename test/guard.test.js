// Browser guard regression tests (need Playwright + Chromium; skipped otherwise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { guardContext } from '../src/browser-guard.js';
import { startGuardProxy, proxyLaunchOptions } from '../src/guard-proxy.js';

let pw = null;
try {
  pw = await import('playwright');
  const b = await pw.chromium.launch();
  await b.close();
} catch {
  pw = null;
}

function listen(handler, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, host, () => resolve(s));
  });
}

test('guard: streams work; off-list redirects (any depth), fetches and ports are blocked; allowed local ports load', { skip: !pw && 'Playwright/Chromium not available' }, async () => {
  const offHits = [];
  const off = await listen((req, res) => {
    offHits.push(req.url);
    res.end('off');
  });
  const offPort = off.address().port;
  const assetHits = [];
  const asset = await listen((req, res) => {
    assetHits.push(req.url);
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  }, 'localhost');
  const assetPort = asset.address().port;
  const big = 'x'.repeat(200000);
  const app = await listen((req, res) => {
    if (req.url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: got hi\n\n'); // stream stays open
      return undefined;
    }
    if (req.url === '/redir') {
      res.writeHead(302, { location: `http://127.0.0.2:${offPort}/escape` });
      return res.end();
    }
    if (req.url === '/chain1') {
      res.writeHead(302, { location: '/chain2' });
      return res.end();
    }
    if (req.url === '/chain2') {
      res.writeHead(302, { location: `http://127.0.0.2:${offPort}/escape2` });
      return res.end();
    }
    if (req.url === '/img-redir') {
      res.writeHead(302, { location: `http://127.0.0.2:${offPort}/img-escape` });
      return res.end();
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<p>${big}</p>`);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<p id=o></p><img id=i src="http://localhost:${assetPort}/a.svg"><img src="/img-redir"><script>
      const es = new EventSource('/sse'); es.onmessage = (e) => { document.getElementById('o').textContent = e.data; };
      fetch('http://127.0.0.2:${offPort}/exfil').catch(() => {});
    </script>`);
  }, 'localhost');
  const port = app.address().port;
  const allowedHosts = [`localhost:${port}`, `localhost:${assetPort}`];
  const proxy = await startGuardProxy({ allowedHosts });
  const browser = await pw.chromium.launch(proxyLaunchOptions('chromium', proxy));
  try {
    const context = await browser.newContext();
    const blocked = [];
    await guardContext(context, { allowedHosts, onBlocked: (b) => blocked.push(b) });
    const page = await context.newPage();
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => document.getElementById('o').textContent === 'got hi', null, { timeout: 5000 });
    await page.waitForFunction(() => document.getElementById('i').naturalWidth > 0, null, { timeout: 5000 });
    assert.ok(assetHits.length >= 1, 'allowed asset on another local port loads');
    await page.goto(`http://localhost:${port}/redir`).catch(() => {});
    await page.goto(`http://localhost:${port}/chain1`).catch(() => {});
    assert.ok(blocked.some((b) => b.redirect && b.url.includes('/escape')), 'off-list redirect recorded');
    assert.ok(blocked.some((b) => b.redirect && b.url.includes('/escape2')), 'two-hop redirect recorded');
    assert.ok(blocked.some((b) => b.url.includes('/exfil')), 'off-list fetch recorded');
    assert.deepEqual(offHits, [], 'off-list server must receive nothing');

    // Offline and throttling apply to page loads because requests stay in the browser.
    await context.setOffline(true);
    await assert.rejects(page.goto(`http://localhost:${port}/big`), 'offline page load fails');
    await context.setOffline(false);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 50000, uploadThroughput: 50000 });
    const t = Date.now();
    await page.goto(`http://localhost:${port}/big`);
    assert.ok(Date.now() - t > 1500, `throttled load took ${Date.now() - t} ms`);
  } finally {
    await browser.close();
    await proxy.close();
    app.closeAllConnections?.();
    app.close();
    asset.closeAllConnections?.();
    asset.close();
    off.close();
  }
});
