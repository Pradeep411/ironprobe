// HTTP client: allow-list check on every hop (redirects included), timeouts, capped body size.
import { assertAllowed } from './safety.js';

const MAX_REDIRECTS = 5;
export const MAX_BODY = 5 * 1024 * 1024;

async function readCapped(res, max) {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      chunks.push(Buffer.from(value.subarray(0, value.byteLength - (size - max))));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return { buf: Buffer.concat(chunks), truncated };
}

export async function send(req, { allowedHosts, timeoutMs = 15000 }) {
  let url = req.url;
  let method = (req.method || 'GET').toUpperCase();
  const headers = { 'user-agent': 'IronProbe/0.1', ...(req.headers || {}) };
  if (req.basicAuth && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
    headers.Authorization = `Basic ${Buffer.from(`${req.basicAuth.username ?? ''}:${req.basicAuth.password ?? ''}`).toString('base64')}`;
  }
  let body;
  const hasHeader = (name) => Object.keys(headers).some((h) => h.toLowerCase() === name);
  if (req.json !== undefined) {
    body = JSON.stringify(req.json);
    if (!hasHeader('content-type')) headers['content-type'] = 'application/json';
  } else if (req.form !== undefined) {
    body = new URLSearchParams(req.form).toString();
    if (!hasHeader('content-type')) headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (req.body !== undefined) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

  const started = performance.now();
  let res;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowed(url, allowedHosts);
    res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && req.followRedirects !== false) {
      await res.body?.cancel().catch(() => {});
      if (hop === MAX_REDIRECTS) throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
      const next = new URL(res.headers.get('location'), url).toString();
      if (new URL(next).origin !== new URL(url).origin) {
        // Never forward credentials to a different origin.
        for (const h of Object.keys(headers)) if (/^(authorization|cookie|proxy-authorization)$/i.test(h)) delete headers[h];
      }
      url = next;
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    break;
  }
  const { buf, truncated } = await readCapped(res, MAX_BODY);
  const ms = Math.round(performance.now() - started);
  const text = buf.toString('utf8');
  let json;
  if (!truncated) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  const outHeaders = {};
  res.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });
  return { status: res.status, ms, headers: outHeaders, text, json, size: buf.length, truncated, finalUrl: url };
}
