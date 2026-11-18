// Assertion checks for API responses. Each returns a list of human-readable failures.
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { query } from './jsonpath.js';
import { safeRegex } from './safety.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const compiled = new Map();

// Compiled validators are cached by content; schemas reusing an $id replace the old one.
function compileSchema(schema) {
  const key = JSON.stringify(schema);
  if (compiled.has(key)) return compiled.get(key);
  if (schema && typeof schema.$id === 'string') ajv.removeSchema(schema.$id);
  const fn = ajv.compile(schema);
  compiled.set(key, fn);
  return fn;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// "/body/flags" strings become guarded regexes; anything else is not a regex.
function toRegex(pattern) {
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(String(pattern));
  return m ? safeRegex(m[1], m[2]) : null;
}

function matchValue(label, actual, expected) {
  // expected can be a literal or a matcher object
  const failures = [];
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    let re = null;
    try {
      re = typeof expected === 'string' ? toRegex(expected) : null;
    } catch (e) {
      return [`${label}: ${e.message}`];
    }
    if (re) {
      try {
        if (!re.test(String(actual))) failures.push(`${label}: "${actual}" does not match ${expected}`);
      } catch (e) {
        failures.push(`${label}: ${e.message}`);
      }
    } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    return failures;
  }
  const m = expected;
  if ('equals' in m && JSON.stringify(actual) !== JSON.stringify(m.equals)) failures.push(`${label}: expected ${JSON.stringify(m.equals)}, got ${JSON.stringify(actual)}`);
  if ('type' in m && typeOf(actual) !== m.type) failures.push(`${label}: expected type ${m.type}, got ${typeOf(actual)}`);
  if ('matches' in m) {
    let re;
    try {
      re = toRegex(m.matches) || safeRegex(m.matches);
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
      return failures;
    }
    try {
      if (!re.test(String(actual))) failures.push(`${label}: "${actual}" does not match ${m.matches}`);
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
    }
  }
  if ('contains' in m) {
    const ok = Array.isArray(actual) ? actual.some((x) => JSON.stringify(x) === JSON.stringify(m.contains)) : String(actual).includes(String(m.contains));
    if (!ok) failures.push(`${label}: does not contain ${JSON.stringify(m.contains)}`);
  }
  if ('gt' in m && !(actual > m.gt)) failures.push(`${label}: ${actual} is not > ${m.gt}`);
  if ('gte' in m && !(actual >= m.gte)) failures.push(`${label}: ${actual} is not >= ${m.gte}`);
  if ('lt' in m && !(actual < m.lt)) failures.push(`${label}: ${actual} is not < ${m.lt}`);
  if ('lte' in m && !(actual <= m.lte)) failures.push(`${label}: ${actual} is not <= ${m.lte}`);
  if ('length' in m) {
    const len = actual?.length;
    if (len !== m.length) failures.push(`${label}: length ${len} is not ${m.length}`);
  }
  if ('oneOf' in m && !m.oneOf.some((x) => JSON.stringify(x) === JSON.stringify(actual))) failures.push(`${label}: ${JSON.stringify(actual)} not in ${JSON.stringify(m.oneOf)}`);
  return failures;
}

export function checkResponse(expect = {}, res) {
  const failures = [];
  if (expect.status !== undefined) {
    const ok = Array.isArray(expect.status) ? expect.status.includes(res.status) : expect.status === res.status;
    if (!ok) failures.push(`status: expected ${JSON.stringify(expect.status)}, got ${res.status}`);
  }
  if (expect.maxStatus !== undefined && res.status > expect.maxStatus) failures.push(`status: ${res.status} is a server error for an edge-case input (expected ≤ ${expect.maxStatus})`);
  if (expect.maxMs !== undefined && res.ms > expect.maxMs) failures.push(`time: ${res.ms} ms is over the ${expect.maxMs} ms budget`);
  if (expect.headers) {
    for (const [name, exp] of Object.entries(expect.headers)) {
      const actual = res.headers[name.toLowerCase()];
      if (actual === undefined) failures.push(`header ${name}: missing`);
      else failures.push(...matchValue(`header ${name}`, actual, exp));
    }
  }
  if (expect.bodyContains !== undefined && !String(res.text).includes(String(expect.bodyContains))) {
    failures.push(`body: does not contain ${JSON.stringify(expect.bodyContains)}`);
  }
  if (expect.body || expect.schema) {
    if (res.json === undefined) {
      failures.push('body: response is not valid JSON');
    } else {
      for (const [path, exp] of Object.entries(expect.body || {})) {
        let result;
        try {
          result = query(res.json, path);
        } catch (e) {
          failures.push(`${path}: ${e.message}`);
          continue;
        }
        if (exp && typeof exp === 'object' && 'exists' in exp) {
          if (exp.exists !== result.found) failures.push(`${path}: expected ${exp.exists ? 'to exist' : 'to be absent'}`);
          const rest = { ...exp };
          delete rest.exists;
          if (result.found && Object.keys(rest).length) failures.push(...matchValue(path, result.value, rest));
        } else if (!result.found) {
          failures.push(`${path}: not found`);
        } else {
          failures.push(...matchValue(path, result.value, exp));
        }
      }
      if (expect.schema) {
        let validate;
        try {
          validate = compileSchema(expect.schema);
        } catch (e) {
          failures.push(`schema: invalid schema (${e.message})`);
        }
        if (validate && !validate(res.json)) {
          for (const err of validate.errors.slice(0, 5)) failures.push(`schema: ${err.instancePath || '(root)'} ${err.message}`);
        }
      }
    }
  }
  return failures;
}
