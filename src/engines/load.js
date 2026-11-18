// Load engine: bounded concurrency, rate-limited, fixed duration. Safety caps are enforced in safety.js.
import { assertAllowed } from '../safety.js';
import { interpolate } from '../vars.js';
import { percentile, round } from '../util.js';

export async function runLoad(load, ctx) {
  const vars = { baseUrl: ctx.config.baseUrl, ...(ctx.config.vars || {}) };
  const req = interpolate({ method: load.method || 'GET', url: load.url, headers: load.headers || {}, json: load.json }, vars, ctx.redactor, []);
  if (!/^https?:\/\//i.test(req.url)) req.url = `${ctx.config.baseUrl}${req.url}`;
  assertAllowed(req.url, ctx.config.allowedHosts);
  const body = req.json !== undefined ? JSON.stringify(req.json) : undefined;
  const headers = { 'user-agent': 'IronProbe/0.1 (+load)', ...(body ? { 'content-type': 'application/json' } : {}), ...req.headers };

  const durationMs = load.durationSec * 1000;
  const minGap = 1000 / load.maxRps;
  const start = performance.now();
  let nextSlot = start;
  const latencies = [];
  const perSecond = new Map();
  const statusCounts = {};
  let errors = 0;
  let requests = 0;

  ctx.log(`  LOAD ${req.method} ${ctx.redactor.redact(req.url)}  ${load.concurrency} workers, ${load.durationSec}s, max ${load.maxRps} req/s`);

  async function worker() {
    while (performance.now() - start < durationMs) {
      const now = performance.now();
      const slot = Math.max(nextSlot, now);
      nextSlot = slot + minGap;
      if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
      if (performance.now() - start >= durationMs) break;
      const t0 = performance.now();
      let ok = false;
      try {
        const res = await fetch(req.url, { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
        await res.arrayBuffer();
        statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
        ok = res.status < 400;
      } catch {
        statusCounts.error = (statusCounts.error || 0) + 1;
      }
      const ms = performance.now() - t0;
      requests++;
      if (!ok) errors++;
      latencies.push(ms);
      const sec = Math.floor((t0 - start) / 1000);
      const bucket = perSecond.get(sec) || { sec, count: 0, errors: 0, lat: [] };
      bucket.count++;
      if (!ok) bucket.errors++;
      bucket.lat.push(ms);
      perSecond.set(sec, bucket);
    }
  }
  await Promise.all(Array.from({ length: load.concurrency }, worker));
  const elapsed = (performance.now() - start) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const timeline = [...perSecond.values()].sort((a, b) => a.sec - b.sec).map((b) => {
    const s = b.lat.sort((x, y) => x - y);
    return { sec: b.sec, rps: b.count, errors: b.errors, p50: round(percentile(s, 50)), p95: round(percentile(s, 95)) };
  });
  const result = {
    method: req.method,
    url: ctx.redactor.redact(req.url),
    concurrency: load.concurrency,
    durationSec: load.durationSec,
    requests,
    rps: round(requests / elapsed, 1),
    errorRate: requests ? round(errors / requests, 4) : 0,
    p50: round(percentile(sorted, 50)),
    p90: round(percentile(sorted, 90)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] || 0),
    statusCounts,
    timeline,
    failures: [],
  };
  const t = load.thresholds || {};
  if (t.p95 !== undefined && result.p95 > t.p95) result.failures.push(`p95 ${result.p95} ms over ${t.p95} ms`);
  if (t.p99 !== undefined && result.p99 > t.p99) result.failures.push(`p99 ${result.p99} ms over ${t.p99} ms`);
  if (t.errorRate !== undefined && result.errorRate > t.errorRate) result.failures.push(`error rate ${(result.errorRate * 100).toFixed(2)}% over ${(t.errorRate * 100).toFixed(2)}%`);
  if (t.minRps !== undefined && result.rps < t.minRps) result.failures.push(`throughput ${result.rps} req/s under ${t.minRps}`);
  result.passed = result.failures.length === 0;
  ctx.log(`  ${result.passed ? 'PASS' : 'FAIL'}  LOAD ${requests} req, ${result.rps} req/s, p95 ${result.p95} ms, errors ${(result.errorRate * 100).toFixed(2)}%`);
  return result;
}
