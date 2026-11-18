// OpenAPI 3.x importer: one smoke + contract test per safe operation.
// By default only GET/HEAD operations are generated (no writes against your API).

// Resolves local $refs for operations, parameters and responses. Schemas keep their $refs; the
// validator resolves those itself (cycles included), so nothing is ever expanded exponentially.
function makeResolver(root) {
  let budget = 200000;
  const resolve = (node, seen) => {
    if (--budget < 0) throw new Error('OpenAPI document is too large or too deeply nested to import.');
    if (Array.isArray(node)) return node.map((n) => resolve(n, seen));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
      const ref = node.$ref;
      if (seen.has(ref)) return {};
      return resolve(lookup(root, ref) ?? {}, new Set([...seen, ref]));
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = k === 'schema' || k === 'schemas' ? v : resolve(v, seen);
    return out;
  };
  return (node) => resolve(node, new Set());
}

function lookup(root, ref) {
  return ref.slice(2).split('/').reduce((acc, key) => acc?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

// Follow $ref chains on a schema just far enough to read its type/example.
function derefSchema(root, schema, depth = 0) {
  if (schema && typeof schema.$ref === 'string' && depth < 20) return derefSchema(root, lookup(root, schema.$ref), depth + 1);
  return schema || {};
}

// Convert OpenAPI 3.0 "nullable" to JSON Schema so Ajv can validate.
function toJsonSchema(schema, depth = 0) {
  if (depth > 200) throw new Error('OpenAPI schema nesting is too deep to import.');
  if (Array.isArray(schema)) return schema.map((x) => toJsonSchema(x, depth + 1));
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (['nullable', 'example', 'xml', 'externalDocs', 'discriminator', 'readOnly', 'writeOnly', 'deprecated'].includes(k)) continue;
    out[k] = k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/') ? `#/definitions/${v.slice(21)}` : toJsonSchema(v, depth + 1);
  }
  if (schema.nullable === true && out.type) out.type = [].concat(out.type, 'null');
  return out;
}

function exampleFor(param) {
  if (param.example !== undefined) return param.example;
  const ex = param.examples && Object.values(param.examples)[0]?.value;
  if (ex !== undefined) return ex;
  if (param.schema?.example !== undefined) return param.schema.example;
  if (param.schema?.default !== undefined) return param.schema.default;
  if (param.schema?.enum?.length) return param.schema.enum[0];
  return undefined;
}

// Edge-case values per schema type. Any 5xx response to these is a server bug (inputs should be rejected with 4xx).
function edgeValues(schema = {}) {
  const t = schema.type;
  if (t === 'integer' || t === 'number') return [0, -1, 2147483648, 'abc', '1.5e308'];
  if (t === 'boolean') return ['maybe', 2];
  return ['', ' ', 'a'.repeat(1025), "'\"<>%00", '../../etc/passwd', '😀'];
}

export function importOpenApi(spec, { includeWrites = false, fuzz = false, baseUrl = '' } = {}) {
  if (!spec?.openapi || !String(spec.openapi).startsWith('3')) throw new Error('Only OpenAPI 3.x documents are supported.');
  const doc = makeResolver(spec)(spec);
  const out = { name: doc.info?.title || 'OpenAPI', vars: {}, tests: [], warnings: [] };
  // The path part of servers[0] (e.g. /v1) is prefixed to every operation.
  let prefix = '';
  const server = doc.servers?.[0]?.url;
  if (server) {
    try {
      prefix = new URL(server, 'http://placeholder').pathname.replace(/\/+$/, '');
    } catch {
      prefix = '';
    }
    // If baseUrl already ends with the server path (e.g. http://host/v1), don't add it twice.
    try {
      const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
      if (prefix && basePath.endsWith(prefix)) prefix = '';
    } catch {
      /* no baseUrl given */
    }
    if (/\{/.test(server)) out.warnings.push(`servers[0] uses variables (${server}); check that baseUrl plus "${prefix}" is right.`);
  }
  if (/"\$ref":"(?!#\/)/.test(JSON.stringify(spec))) out.warnings.push('The spec references other files ($ref to another document). Those schemas are not checked; bundle the spec into one file first.');
  const methods = includeWrites ? ['get', 'head', 'post', 'put', 'patch', 'delete'] : ['get', 'head'];
  for (const [path, item] of Object.entries(doc.paths || {})) {
    for (const method of methods) {
      const op = item[method];
      if (!op) continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])];
      let url = `${prefix}${path}`;
      let skip = null;
      const query = [];
      for (const p of params) {
        const value = exampleFor(p);
        if (p.in === 'path') {
          if (value === undefined) skip = `path parameter "${p.name}" has no example`;
          else url = url.replace(`{${p.name}}`, encodeURIComponent(value));
        } else if (p.in === 'query' && p.required) {
          if (value === undefined) skip = `required query parameter "${p.name}" has no example`;
          else query.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(value)}`);
        }
      }
      if (query.length) url += `?${query.join('&')}`;
      const codes = Object.keys(op.responses || {});
      const okCode = codes.find((c) => /^2\d\d$/.test(c));
      const expect = { status: okCode ? Number(okCode) : [200, 201, 202, 204] };
      const schema = method !== 'head' && okCode && op.responses[okCode]?.content?.['application/json']?.schema;
      const external = schema && /"\$ref":"(?!#\/)/.test(JSON.stringify(schema));
      if (schema && !external) {
        // Component schemas travel with the response schema; the validator resolves refs lazily.
        const definitions = toJsonSchema(spec.components?.schemas || {});
        expect.schema = Object.keys(definitions).length ? { allOf: [toJsonSchema(schema)], definitions } : toJsonSchema(schema);
      }
      const name = op.operationId || `${method.toUpperCase()} ${path}`;
      const security = op.security ?? doc.security;
      const test = { name, request: { method: method.toUpperCase(), url }, expect };
      if (skip) test.skip = `${skip}; add an example to the spec or write this test by hand`;
      if (security?.length) out.warnings.push(`"${name}" needs auth: add headers (e.g. Authorization: Bearer {{env.API_TOKEN}}) to the generated suite.`);
      out.tests.push(test);

      // Fuzz: for GET/HEAD only, swap each parameter with edge values and require "no server error".
      if (fuzz && !skip && (method === 'get' || method === 'head')) {
        for (const p of params.filter((x) => x.in === 'path' || x.in === 'query')) {
          for (const bad of edgeValues(derefSchema(spec, p.schema))) {
            let fuzzUrl = `${prefix}${path}`;
            const qs = [];
            for (const q of params) {
              const v = q === p ? bad : exampleFor(q);
              if (q.in === 'path') fuzzUrl = fuzzUrl.replace(`{${q.name}}`, encodeURIComponent(v ?? 1));
              else if (q.in === 'query' && (q === p || q.required) && v !== undefined) qs.push(`${encodeURIComponent(q.name)}=${encodeURIComponent(v)}`);
            }
            if (qs.length) fuzzUrl += `?${qs.join('&')}`;
            out.tests.push({
              name: `fuzz ${name} ${p.name}=${JSON.stringify(bad).slice(0, 24)}`,
              request: { method: method.toUpperCase(), url: fuzzUrl },
              expect: { maxStatus: 499 },
              fuzz: true,
              dependsOn: name,
            });
          }
        }
      }
    }
  }
  if (fuzz) out.warnings.push('Fuzz tests check that edge-case inputs never cause a 5xx server error.');
  if (!includeWrites) out.warnings.push('Only GET/HEAD operations were generated (safe default). Use includeWrites: true to add writes.');
  return out;
}
