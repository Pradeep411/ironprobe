// Variable interpolation: {{name}}, {{env.NAME}}, {{$uuid}}, {{$timestamp}}.
import { randomUUID } from 'node:crypto';

const PATTERN = /\{\{\s*([^}\s]+)\s*\}\}/g;

export function interpolate(value, vars, redactor, warnings) {
  if (typeof value === 'string') {
    return value.replace(PATTERN, (match, key) => {
      if (key === '$uuid' || key === '$guid' || key === '$randomUUID') return randomUUID();
      if (key === '$timestamp') return String(Math.floor(Date.now() / 1000));
      if (key === '$isoTimestamp') return new Date().toISOString();
      if (key === '$randomInt') return String(Math.floor(Math.random() * 1001));
      if (key.startsWith('env.')) {
        const name = key.slice(4);
        const v = process.env[name];
        if (v === undefined) {
          warnings?.push(`Environment variable ${name} is not set.`);
          return '';
        }
        redactor?.add(v);
        return v;
      }
      if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
      warnings?.push(`Variable {{${key}}} is not defined.`);
      return match;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars, redactor, warnings));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, vars, redactor, warnings);
    return out;
  }
  return value;
}
