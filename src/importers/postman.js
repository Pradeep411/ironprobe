import { SECRET_PARAM } from './har.js';
// Postman Collection v2.0/v2.1 importer. Scripts are NEVER executed: common pm.* assertions are
// translated with pattern matching; everything else is reported as "untranslated" for review.

function urlFrom(u) {
  if (!u) return '';
  if (typeof u === 'string') return u;
  // Prefer structured parts when there are query params, so disabled ones are dropped.
  const hasParts = Array.isArray(u.host) || Array.isArray(u.path);
  if (u.raw && !(hasParts && Array.isArray(u.query) && u.query.some((x) => x.disabled))) {
    // Postman path variables (:id) take their values from url.variable.
    let raw = u.raw;
    for (const v of u.variable || []) if (v.key) raw = raw.replace(new RegExp(`:${v.key.replace(/[^\w-]/g, '')}(?=/|\\?|$)`), encodeURIComponent(String(v.value ?? '')));
    return raw;
  }
  const host = `${Array.isArray(u.host) ? u.host.join('.') : u.host || ''}${u.port ? `:${u.port}` : ''}`;
  const path = Array.isArray(u.path) ? u.path.join('/') : u.path || '';
  const q = (u.query || []).filter((x) => !x.disabled).map((x) => `${encodeURIComponent(x.key)}=${encodeURIComponent(x.value ?? '')}`).join('&');
  return `${u.protocol ? `${u.protocol}://` : ''}${host}${path ? `/${path}` : ''}${q ? `?${q}` : ''}`;
}

function authHeaders(auth) {
  if (!auth || !auth.type) return {};
  const list = auth[auth.type] || [];
  const get = (k) => list.find((x) => x.key === k)?.value;
  if (auth.type === 'bearer' && get('token')) return { Authorization: `Bearer ${get('token')}` };
  if (auth.type === 'apikey' && (get('in') || 'header') === 'header' && get('key')) return { [get('key')]: get('value') ?? '' };
  return {};
}

// Translate common test-script lines into IronProbe expectations.
export function translateScript(lines) {
  const expect = {};
  const extract = {};
  const untranslated = [];
  const body = {};
  for (const raw of lines) {
    const line = raw.trim();
    // Structural lines carry no assertion of their own.
    if (!line || line.startsWith('//') || /^\}\)?\s*;?$/.test(line) || /^(var|let|const)\s+\w+\s*=\s*pm\.response\.json\(\)\s*;?$/.test(line)) continue;
    let m;
    if ((m = /pm\.response\.to\.have\.status\((\d{3})\)/.exec(line))) {
      expect.status = Number(m[1]);
    } else if ((m = /pm\.expect\(pm\.response\.code\)\.to\.(?:eql|equal|be\.equal|eq)\((\d{3})\)/.exec(line))) {
      expect.status = Number(m[1]);
    } else if ((m = /pm\.expect\(pm\.response\.code\)\.to\.be\.oneOf\(\[([\d,\s]+)\]\)/.exec(line))) {
      expect.status = m[1].split(',').map((x) => Number(x.trim()));
    } else if ((m = /pm\.response\.responseTime\)\.to\.be\.(?:below|lessThan|lt)\((\d+)\)/.exec(line))) {
      expect.maxMs = Number(m[1]);
    } else if ((m = /pm\.response\.to\.have\.header\(["']([^"']+)["']\)/.exec(line))) {
      expect.headers = { ...(expect.headers || {}), [m[1]]: '/.*/' };
    } else if ((m = /pm\.expect\(pm\.response\.text\(\)\)\.to\.include\(["']([^"']*)["']\)/.exec(line))) {
      expect.bodyContains = m[1];
    } else if ((m = /pm\.expect\((?:pm\.response\.json\(\)|jsonData|json|data|body|response)((?:\.\w+|\[\d+\])+)\)\.to\.(?:eql|equal|eq)\((.+)\);?$/.exec(line))) {
      try {
        body[`$${m[1]}`] = JSON.parse(m[2].replace(/'/g, '"'));
      } catch {
        untranslated.push(line);
      }
    } else if ((m = /pm\.expect\((?:pm\.response\.json\(\)|jsonData|json|data|body|response)((?:\.\w+|\[\d+\])+)\)\.to\.(?:exist|be\.ok|not\.be\.undefined)/.exec(line))) {
      body[`$${m[1]}`] = { exists: true };
    } else if ((m = /pm\.expect\((?:pm\.response\.json\(\)|jsonData|json|data|body|response)((?:\.\w+|\[\d+\])+)\)\.to\.be\.an?\(["'](\w+)["']\)/.exec(line))) {
      body[`$${m[1]}`] = { type: m[2] };
    } else if ((m = /pm\.(?:environment|collectionVariables|globals|variables)\.set\(["']([^"']+)["']\s*,\s*(?:pm\.response\.json\(\)|jsonData|json|data|body|response)((?:\.\w+|\[\d+\])+)\)/.exec(line))) {
      extract[m[1]] = `$${m[2]}`;
    } else if (/pm\.|postman\.|eval|require\(/.test(line) && !/^pm\.test\(/.test(line)) {
      untranslated.push(line);
    }
  }
  if (Object.keys(body).length) expect.body = body;
  return { expect, extract, untranslated };
}

function walk(items, prefix, out, inheritedAuth) {
  for (const item of items || []) {
    const name = prefix ? `${prefix} / ${item.name}` : item.name;
    if (item.item) {
      if ((item.event || []).some((ev) => [].concat(ev.script?.exec || []).some((l) => String(l).trim()))) {
        out.warnings.push(`Folder "${name}" has scripts that apply to all its requests; they were not run. Review them.`);
      }
      walk(item.item, name, out, item.auth || inheritedAuth);
      continue;
    }
    const r = item.request;
    if (!r) continue;
    const request = typeof r === 'string' ? { method: 'GET', url: r } : r;
    const auth = request.auth || inheritedAuth;
    const headers = { ...authHeaders(auth) };
    for (const h of request.header || []) if (!h.disabled) headers[h.key] = h.value;
    const req = { method: request.method || 'GET', url: urlFrom(request.url), headers };
    collectUrlSecrets(req.url, out.secrets);
    if (auth?.type === 'basic') {
      // Encoded at send time, after {{variables}} are filled in.
      const list = auth.basic || [];
      const get = (k) => list.find((x) => x.key === k)?.value;
      req.basicAuth = { username: get('username') ?? '', password: get('password') ?? '' };
    }
    if (auth && !['bearer', 'basic', 'apikey', 'noauth'].includes(auth.type)) out.warnings.push(`"${name}": ${auth.type} auth is not imported; add the header by hand.`);
    const authText = JSON.stringify(auth || {});
    if (auth && auth.type !== 'noauth' && !/\{\{/.test(authText) && /"value":"[^"]{6,}"/.test(authText)) {
      out.warnings.push(`"${name}": the collection contains a literal credential. Replace it with {{env.NAME}} in the generated suite.`);
    }
    const b = request.body;
    let skipReason = null;
    if (b?.mode === 'raw' && b.raw) {
      try {
        req.json = JSON.parse(b.raw);
      } catch {
        req.body = b.raw;
        const lang = b.options?.raw?.language;
        if ((lang === 'json' || /^\s*[[{]/.test(b.raw)) && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }
    } else if (b?.mode === 'urlencoded') {
      req.form = Object.fromEntries((b.urlencoded || []).filter((x) => !x.disabled).map((x) => [x.key, x.value ?? '']));
    } else if (b?.mode && b.mode !== 'none' && b.mode !== 'raw') {
      skipReason = `body type "${b.mode}" is not supported yet; test this request by hand`;
      out.warnings.push(`"${name}": body mode "${b.mode}" is not imported yet; the test is marked skip.`);
    }
    const lines = [];
    for (const ev of item.event || []) {
      if (ev.listen === 'test') lines.push(...[].concat(ev.script?.exec || []));
      if (ev.listen === 'prerequest' && [].concat(ev.script?.exec || []).some((l) => l.trim())) {
        out.warnings.push(`"${name}": pre-request script not executed (review manually).`);
      }
    }
    const t = translateScript(lines);
    const test = { name, request: req, expect: Object.keys(t.expect).length ? t.expect : { status: [200, 201, 202, 204] } };
    if (skipReason) test.skip = skipReason;
    if (Object.keys(t.extract).length) test.extract = t.extract;
    if (t.untranslated.length) test.untranslated = t.untranslated;
    out.tests.push(test);
  }
}

// Secret-looking values in a request address (?token=..., ?api_key=...) are still sent, but masked in
// every log, result and report, the same way the HAR importer treats them.
function collectUrlSecrets(url, secrets) {
  const q = String(url).split('#')[0].split('?').slice(1).join('?');
  if (!q) return;
  for (const pair of q.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const raw = pair.slice(eq + 1);
    if (/^\{\{[^{}]+\}\}$/.test(raw)) continue; // a {{variable}}, not a value
    let key = pair.slice(0, eq);
    let val = raw;
    try {
      key = decodeURIComponent(key.replace(/\+/g, ' '));
      val = decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      /* keep raw */
    }
    for (const v of new Set([raw, val])) if (v.length >= 4 && (SECRET_PARAM.test(key) || v.length >= 24)) secrets.push(v);
  }
}

export function importPostman(collection) {
  if (!collection?.info || !Array.isArray(collection.item)) throw new Error('Not a Postman v2.x collection (missing info/item).');
  const out = { name: collection.info.name || 'Postman collection', vars: {}, tests: [], warnings: [], secrets: [] };
  for (const v of collection.variable || []) if (v.key) out.vars[v.key] = v.value ?? '';
  if ((collection.event || []).some((ev) => [].concat(ev.script?.exec || []).some((l) => String(l).trim()))) {
    out.warnings.push('The collection has collection-level scripts; they were not run. Review them.');
  }
  walk(collection.item, '', out, collection.auth);
  return out;
}
