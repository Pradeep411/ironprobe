import v8 from 'node:v8';

// Safety gate: host allow-list, load caps, regex guard and secret redaction.

export const LOAD_CAPS = Object.freeze({ maxConcurrency: 50, maxDurationSec: 120, maxRps: 200 });
export const CRAWL_CAP = 100;

export class SafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafetyError';
  }
}

const stripDot = (h) => h.toLowerCase().replace(/\.+$/, '');

// Pattern forms: "example.com", "*.example.com", "localhost:3000", "[::1]:8080" or "::1".
function parsePattern(pattern) {
  let p = String(pattern).trim().toLowerCase();
  if (!p) return null;
  const wildcard = p.startsWith('*.');
  if (wildcard) p = p.slice(2);
  if ((p.match(/:/g) || []).length > 1 && !p.startsWith('[')) p = `[${p}]`; // bare IPv6
  let u;
  try {
    u = new URL(`http://${p}`);
  } catch {
    return null;
  }
  return { host: stripDot(u.hostname.replace(/^\[|\]$/g, '')), port: u.port || (/:80$/.test(p) ? '80' : null), wildcard };
}

function hostMatches(url, pattern) {
  const parsed = parsePattern(pattern);
  if (!parsed || !parsed.host) return false;
  let { host: p, port } = parsed;
  if (parsed.wildcard) p = `*.${p}`;
  const host = stripDot(url.hostname.replace(/^\[|\]$/g, ''));
  const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (port && port !== effectivePort) return false;
  if (p.startsWith('*.')) {
    const base = stripDot(p.slice(2));
    if (!base || (!base.includes('.') && base !== 'localhost')) return false;
    // Refuse wildcards over shared suffixes such as *.co.uk or *.com.au.
    if (/^(co|com|org|net|gov|ac|edu|ne|or|go)\.[a-z]{2}$/.test(base)) return false;
    return host === base || host.endsWith(`.${base}`);
  }
  return host === stripDot(p);
}

export function isHostAllowed(rawUrl, allowedHosts) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return (allowedHosts || []).some((pattern) => hostMatches(url, pattern));
}

export function assertAllowed(rawUrl, allowedHosts) {
  if (!isHostAllowed(rawUrl, allowedHosts)) {
    let host = rawUrl;
    try {
      host = new URL(rawUrl).host;
    } catch {
      /* keep raw */
    }
    throw new SafetyError(`"${host}" is not in allowedHosts. Add it only if you own or are authorised to test it.`);
  }
}

export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function validateLoadConfig(load, config) {
  if (!load) return null;
  if (config.iOwnThisTarget !== true) {
    throw new SafetyError('Load test refused: set "iOwnThisTarget: true" in the config to confirm you own the target.');
  }
  const concurrency = Number(load.concurrency ?? 5);
  const durationSec = Number(load.durationSec ?? 10);
  const maxRps = Number(load.maxRps ?? 50);
  for (const [name, value] of Object.entries({ concurrency, durationSec, maxRps })) {
    if (!Number.isFinite(value) || value <= 0) throw new SafetyError(`Load test: "${name}" must be a positive number.`);
  }
  if (concurrency > LOAD_CAPS.maxConcurrency) throw new SafetyError(`Load test: concurrency is capped at ${LOAD_CAPS.maxConcurrency}.`);
  if (durationSec > LOAD_CAPS.maxDurationSec) throw new SafetyError(`Load test: duration is capped at ${LOAD_CAPS.maxDurationSec}s.`);
  if (maxRps > LOAD_CAPS.maxRps) throw new SafetyError(`Load test: maxRps is capped at ${LOAD_CAPS.maxRps}.`);
  return { ...load, concurrency: Math.floor(concurrency), durationSec, maxRps };
}

// Regexes come from test files and run against server-controlled text. They run on V8's linear-time
// engine (the "l" flag), which cannot backtrack, so no pattern can hang the run. Back-references and
// lookarounds are not supported there and are rejected. Case-insensitive matching lowercases both sides.
export const REGEX_INPUT_CAP = 10000;
let linearEngine = false;
try {
  v8.setFlagsFromString('--enable-experimental-regexp-engine');
  linearEngine = new RegExp('a+', 'l').test('a');
} catch {
  linearEngine = false;
}
if (!linearEngine) {
  process.emitWarning('IronProbe: the linear-time regex engine is not available in this Node.js build; using pattern checks instead. Upgrade Node.js for full protection.');
}

function lowerOutsideEscapes(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\\') {
      out += src[i] + (src[i + 1] ?? '');
      i++;
    } else out += src[i].toLowerCase();
  }
  return out;
}

export function safeRegex(pattern, flags = '') {
  let src = String(pattern);
  if (src.length > 500) throw new Error('regex is longer than 500 characters');
  const ignoreCase = /i/.test(flags);
  const keep = flags.replace(/[^ms]/g, '');
  let re;
  if (linearEngine) {
    if (ignoreCase) {
      if (/\\[pPxuc]/.test(src)) throw new Error(`regex "${pattern}" mixes the "i" flag with \\p, \\x, \\u or \\c escapes; write the letters directly instead`);
      src = lowerOutsideEscapes(src);
    }
    try {
      re = new RegExp(src, `${keep}l`);
    } catch {
      throw new Error(`regex "${pattern}" uses back-references or lookarounds, which IronProbe does not run; simplify it`);
    }
  } else {
    // Fallback for runtimes without the linear engine: refuse the most common catastrophic shapes.
    if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]|\\[1-9]|\((?:[^()|]*\|)+[^()]*\)[+*]|(\\[wdsWDS.]\*){3,}/.test(src)) {
      throw new Error(`regex "${src}" has nested repetition or back-references, which can hang the run; simplify it`);
    }
    re = new RegExp(src, flags.replace(/[^imsu]/g, ''));
  }
  return {
    test: (s) => {
      let text = String(s);
      if (text.length > REGEX_INPUT_CAP) throw new Error(`text is ${text.length} characters, over the ${REGEX_INPUT_CAP}-character limit for regex checks; use bodyContains or a JSONPath check`);
      if (linearEngine && ignoreCase) text = text.toLowerCase();
      return re.test(text);
    },
  };
}

export function clampRetries(value, fallback = 0) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.floor(n))) : fallback;
}

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|api[-_]?key|secret|session|csrf|xsrf|password/i;

// Collects secret values (from {{env.X}} lookups, secretEnv and captured tokens) and masks them
// anywhere in output, including URL-encoded and base64 forms.
export class Redactor {
  constructor() {
    this.secrets = new Set();
  }

  add(value) {
    if (typeof value === 'number') value = String(value);
    if (typeof value !== 'string' || value.length < 4) return;
    const variants = [value, encodeURIComponent(value), encodeURI(value), encodeURIComponent(value).replace(/%20/g, '+'), Buffer.from(value).toString('base64')];
    for (const v of variants) if (v.length >= 4) this.secrets.add(v);
  }

  redact(input) {
    if (input == null) return input;
    if (typeof input === 'string') {
      let out = input;
      for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join('***');
      return out;
    }
    if (Array.isArray(input)) return input.map((v) => this.redact(v));
    if (typeof input === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(input)) {
        out[k] = SENSITIVE_HEADER.test(k) && typeof v === 'string' ? '***' : this.redact(v);
      }
      return out;
    }
    return input;
  }
}
