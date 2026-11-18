import { createHash } from 'node:crypto';

// Small shared helpers.

export const VERSION = '0.1.0';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[idx];
}

// File-safe name. Text with little or no Latin content gets a short stable hash so names never collide.
export function slug(text) {
  const raw = String(text ?? '');
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const latinShare = raw.length ? (raw.match(/[a-z0-9]/gi) || []).length / raw.replace(/[\s/_-]/g, '').length : 1;
  if (base && latinShare > 0.6) return base;
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return base ? `${base}-${hash}` : raw === '/' || raw === '' ? 'root' : `u-${hash}`;
}

export function truncate(text, max = 2000) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more chars]` : s;
}

export function round(n, digits = 0) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// Classify a failure so people fix the right thing: the app, the test, or the environment.
export function categorize(message) {
  const m = String(message || '');
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|net::ERR_|socket hang up|Target (page|browser).* closed|browser has been closed|request failed: (timed out|fetch failed)|fetch failed/i.test(m)) return 'infrastructure';
  if (/unknown action|Bad JSONPath|extract |invalid schema|strict mode violation|waiting for locator|locator\.|Timeout \d+ms exceeded/i.test(m)) return 'test';
  return 'app';
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
