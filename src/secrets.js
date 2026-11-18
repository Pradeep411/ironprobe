// Secret scanner for test files and collections (the #1 Postman leak problem).
// Reports file:line with the value masked. Values written as {{env.NAME}} are the safe pattern.
import fs from 'node:fs';
import path from 'node:path';

const RULES = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{16,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['Hard-coded bearer token', /Bearer\s+(?!\{\{|\$\{)[A-Za-z0-9._~+/-]{24,}=*/],
  ['Hard-coded Basic auth', /Basic\s+(?!\{\{|\$\{)[A-Za-z0-9+/]{12,}={0,2}/],
  ['Postman credential', /"key"\s*:\s*"(?:password|passwd|token|access_?token|api_?key|apikey|secret|client_?secret)"\s*,\s*"value"\s*:\s*"(?!\{\{)[^"]{4,}"/i],
  ['Secret in a web address', /[?&](?:api[_-]?key|apikey|access[_-]?key|token|access_token|secret|signature|password|auth)=(?!\{\{|\$\{|\*\*\*)[^&\s"'#]{8,}/i],
  ['Credential field', /(?:^|[\s{,"'])["']?(?:[A-Za-z0-9]+[_-])?(?:password|passwd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*(["']?)(?!\{\{|\$\{|<)([^\s"',}#]{6,})\1/i],
];

const PLACEHOLDER = /^(x+|\*+|changeme|change-me|password|secret|example|placeholder|your[-_].*|<.*>|null|none|true|false|undefined)$/i;

const EXT = /\.(ya?ml|json|env|txt|md|js|mjs|ts|http|bru|hurl|ini|toml)$|(^|[\\/])\.env(\.[\w-]+)?$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'ironprobe-report', '.ironprobe', 'dist', 'build']);

function mask(value) {
  return value.length <= 8 ? '***' : `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

export function scanText(text, file) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/ironprobe:ignore/.test(line)) return; // explicit, reviewed exception (e.g. a demo password)
    for (const [kind, re] of RULES) {
      const m = re.exec(line);
      if (!m) continue;
      if (kind === 'Credential field' && PLACEHOLDER.test(m[2])) continue;
      findings.push({ file, line: i + 1, kind, preview: mask(m[0].trim()) });
      break; // one finding per line is enough
    }
  });
  // JSON exports (Postman, Insomnia) spread one credential over several lines: {"key": "password",
  // "value": "..."}. Walk the parsed structure so pretty-printed files are caught too.
  if (/\.json$/i.test(file || '') || /^\s*[{[]/.test(text)) {
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = null;
    }
    if (doc) {
      const lines = text.split(/\r?\n/);
      const seenLines = new Set(findings.map((f) => f.line));
      const report = (kind, value) => {
        const needle = JSON.stringify(value).slice(1, -1);
        let line = lines.findIndex((l) => l.includes(needle));
        if (line >= 0 && /ironprobe:ignore/.test(lines[line])) return;
        line = line >= 0 ? line + 1 : 1;
        if (seenLines.has(line)) return;
        seenLines.add(line);
        findings.push({ file, line, kind, preview: mask(value) });
      };
      const SENSITIVE = /^(password|passwd|pwd|token|access_?token|auth_?token|api_?key|apikey|secret|client_?secret|private_?key)$/i;
      const walk = (node, parentKey, depth) => {
        if (!node || typeof node !== 'object' || depth > 40) return;
        if (Array.isArray(node)) return node.forEach((n) => walk(n, parentKey, depth + 1));
        if (typeof node.key === 'string' && typeof node.value === 'string') {
          const v = node.value;
          const sensitive = SENSITIVE.test(node.key) || (node.key === 'value' && /^apikey$/i.test(parentKey || ''));
          if (sensitive && v.length >= 4 && !/^\{\{|^\$\{|^</.test(v) && !PLACEHOLDER.test(v)) report('Postman credential', v);
        }
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === 'string' && SENSITIVE.test(k) && v.length >= 6 && !/^\{\{|^\$\{|^</.test(v) && !PLACEHOLDER.test(v)) report('Credential field', v);
          else walk(v, k, depth + 1);
        }
        return undefined;
      };
      walk(doc, null, 0);
    }
  }
  return findings;
}

export class ScanPathError extends Error {}

export function scanPaths(paths, { maxFiles = 2000, skipDirs = [], strict = false } = {}) {
  if (strict) for (const p of paths) if (!fs.existsSync(p)) throw new ScanPathError(`Path not found: ${p}`);
  const findings = [];
  let count = 0;
  const skip = new Set([...SKIP_DIRS, ...skipDirs]);
  const visit = (p) => {
    if (count >= maxFiles || !fs.existsSync(p)) return;
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      const base = path.basename(p);
      if (skip.has(base) || base.startsWith('ironprobe-report')) return;
      for (const child of fs.readdirSync(p)) visit(path.join(p, child));
    } else if (EXT.test(p) && st.size < 2 * 1024 * 1024) {
      count++;
      findings.push(...scanText(fs.readFileSync(p, 'utf8'), p));
    }
  };
  for (const p of paths) visit(p);
  return findings;
}
