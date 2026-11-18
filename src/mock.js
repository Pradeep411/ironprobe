// Local mock server from an OpenAPI 3 spec. Serves spec examples, or sample data built from the
// response schema, so frontend work can start before the backend exists. Listens on 127.0.0.1 only.
import http from 'node:http';

function lookup(root, ref) {
  return ref.slice(2).split('/').reduce((acc, key) => acc?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

export function sample(schema, root, depth = 0) {
  if (!schema || depth > 40) return null;
  // Recursive schemas (a Node with a parent Node) stop after a few levels; plain fields never
  // turn into null, so typed fields such as integer ids keep their type.
  if (schema.$ref) return depth > 6 ? null : sample(lookup(root, schema.$ref), root, depth + 1);
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  const all = schema.allOf || schema.oneOf || schema.anyOf;
  if (all?.length) return schema.allOf ? Object.assign({}, ...all.map((s) => sample(s, root, depth + 1))) : sample(all[0], root, depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type || (schema.properties ? 'object' : 'string')) {
    case 'object': {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties || {})) out[k] = sample(v, root, depth + 1);
      return out;
    }
    case 'array': {
      const item = sample(schema.items || {}, root, depth + 1);
      return item === null && schema.items?.$ref ? [] : [item];
    }
    case 'integer': return schema.minimum ?? 1;
    case 'number': return schema.minimum ?? 1.5;
    case 'boolean': return true;
    default:
      if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (schema.format === 'date') return '2026-01-01';
      if (schema.format === 'email') return 'user@example.com';
      if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (schema.format === 'uri') return 'https://example.com';
      return 'string';
  }
}

function compileRoutes(spec) {
  const routes = [];
  for (const [p, item] of Object.entries(spec.paths || {})) {
    const names = [];
    const pattern = new RegExp(`^${p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{([^}]+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; })}/?$`);
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      if (item[method]) routes.push({ method: method.toUpperCase(), path: p, pattern, op: item[method] });
    }
  }
  return routes;
}

// The base path from servers[0] (e.g. "/v1"), which `import openapi` adds to every request.
export function serverBasePath(spec) {
  const raw = spec.servers?.[0]?.url;
  if (!raw) return '';
  try {
    return new URL(raw, 'http://placeholder').pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function mockResponse(spec, method, rawPath) {
  const routes = compileRoutes(spec);
  const base = serverBasePath(spec);
  const urlPath = base && (rawPath === base || rawPath.startsWith(`${base}/`)) ? rawPath.slice(base.length) || '/' : rawPath;
  const route = routes.find((r) => r.method === method && r.pattern.test(urlPath));
  if (!route) {
    const anyMethod = routes.some((r) => r.pattern.test(urlPath));
    return { status: anyMethod ? 405 : 404, body: { error: anyMethod ? 'method not allowed in spec' : 'path not in spec' } };
  }
  const codes = Object.keys(route.op.responses || {});
  const code = codes.find((c) => /^2\d\d$/.test(c)) || codes[0] || '200';
  let response = route.op.responses?.[code] || {};
  if (response.$ref) response = lookup(spec, response.$ref) || {};
  const media = response.content?.['application/json'];
  let body = null;
  if (media) {
    if (media.example !== undefined) body = media.example;
    else if (media.examples) body = Object.values(media.examples)[0]?.value ?? null;
    else body = sample(media.schema, spec);
  }
  return { status: code === 'default' ? 200 : Number(code), body, operation: route.op.operationId || `${method} ${route.path}` };
}

export function startMock(spec, { port = 4020, log = console.log } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const r = mockResponse(spec, req.method, url.pathname);
    log(`  ${req.method} ${url.pathname} -> ${r.status}${r.operation ? ` (${r.operation})` : ''}`);
    res.writeHead(r.status, { 'content-type': 'application/json', 'x-ironprobe-mock': '1' });
    res.end(r.status === 204 || r.body == null ? '' : JSON.stringify(r.body));
  });
  return new Promise((resolve, reject) => {
    server.on('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use; pick another with --port` : e.message)));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
