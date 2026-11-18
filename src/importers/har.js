// HAR import: turns a browser recording (DevTools > Network > "Save all as HAR") into API checks.
// Only GET/HEAD requests to the tested host become tests, so replaying them never changes data.
// Cookies and auth headers in the recording are never copied into tests.
import { isHostAllowed } from '../safety.js';

export const SECRET_PARAM = /(api[_-]?key|apikey|access[_-]?key|token|secret|signature|^sig$|auth|session|password|passwd|^pass$|jwt|bearer|credential)/i;
const SKIP_TYPES = /\.(png|jpe?g|gif|webp|avif|svg|ico|css|woff2?|ttf|otf|map|mp4|webm|mp3)(\?|$)/i;

export function importHar(har, { allowedHosts = [], max = 60 } = {}) {
  const warnings = [];
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('Not a HAR file: log.entries is missing.');
  const seen = new Set();
  const secrets = new Set();
  const tests = [];
  let skippedWrites = 0;
  let skippedHosts = 0;
  for (const e of entries) {
    const req = e?.request;
    if (!req || typeof req.url !== 'string') continue;
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      skippedWrites++;
      continue;
    }
    if (!/^https?:/i.test(req.url) || SKIP_TYPES.test(req.url)) continue;
    if (!isHostAllowed(req.url, allowedHosts)) {
      skippedHosts++;
      continue;
    }
    const u = new URL(req.url);
    // Secret-looking query values (api_key=..., token=...) are kept for the request but masked
    // everywhere in results, and never put in test names.
    for (const [k, v] of u.searchParams) {
      if (v.length >= 4 && (SECRET_PARAM.test(k) || v.length >= 24)) secrets.add(v);
    }
    // Also the raw text as it appears in the address (+, / and %2B survive there undecoded).
    for (const pair of u.search.slice(1).split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const rawKey = pair.slice(0, eq);
      const rawVal = pair.slice(eq + 1);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        /* keep raw */
      }
      if (rawVal.length >= 4 && (SECRET_PARAM.test(key) || rawVal.length >= 24)) secrets.add(rawVal);
    }
    const shown = u.search ? `${u.pathname}?${[...u.searchParams.keys()].join('&')}` : u.pathname;
    const key = `${method} ${u.pathname}${u.search}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const status = Number(e.response?.status) || 0;
    const mime = String(e.response?.content?.mimeType || '');
    // 304 came from the browser cache (we send no cache headers, so expect 200); redirects are
    // followed on replay, so any non-error answer is fine.
    const expect = status === 304 ? { status: 200 } : status >= 300 && status < 400 ? { maxStatus: 399 } : status >= 200 && status < 300 ? { status } : { maxStatus: 499 };
    if (/json/i.test(mime) && status >= 200 && status < 300) expect.headers = { 'content-type': '/json/' };
    const time = Number(e.time);
    if (Number.isFinite(time) && time > 0) expect.maxMs = Math.max(1000, Math.round(time * 3));
    tests.push({ name: `${method} ${shown}`.slice(0, 120), request: { method, url: `${u.pathname}${u.search}` }, expect });
    if (tests.length >= max) {
      warnings.push(`Only the first ${max} distinct requests were imported.`);
      break;
    }
  }
  if (skippedWrites) warnings.push(`${skippedWrites} request(s) that change data (POST, PUT, DELETE...) were not replayed.`);
  if (skippedHosts) warnings.push(`${skippedHosts} request(s) to other hosts were left out.`);
  return { name: 'Recorded traffic (HAR)', setup: [], tests, teardown: [], warnings, secrets: [...secrets] };
}

// Works out what an uploaded file is, from its contents rather than its name.
export function detectKind(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.log && Array.isArray(doc.log.entries)) return 'har';
  if (Array.isArray(doc.values) && (doc._postman_variable_scope || (doc.name && !doc.item))) return 'postman-env';
  if (doc.openapi || doc.swagger) return 'openapi';
  if (doc.info && (String(doc.info.schema || '').includes('postman') || Array.isArray(doc.item))) return 'postman';
  if (Array.isArray(doc.tests) || Array.isArray(doc.setup)) return 'suite';
  return null;
}
