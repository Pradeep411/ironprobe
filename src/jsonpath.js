// Minimal, safe JSONPath subset: $, .key, ['key'], [index], .length
// No filters or script expressions (nothing is evaluated).

export function tokenize(path) {
  if (typeof path !== 'string' || !path.startsWith('$')) throw new Error(`JSONPath must start with "$": ${path}`);
  const tokens = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      const m = /^\.([A-Za-z_$][\w$-]*)/.exec(path.slice(i));
      if (!m) throw new Error(`Bad JSONPath near "${path.slice(i)}"`);
      tokens.push(m[1]);
      i += m[0].length;
    } else if (ch === '[') {
      const m = /^\[(\d+|'[^']*'|"[^"]*")\]/.exec(path.slice(i));
      if (!m) throw new Error(`Bad JSONPath near "${path.slice(i)}"`);
      const raw = m[1];
      tokens.push(/^\d+$/.test(raw) ? Number(raw) : raw.slice(1, -1));
      i += m[0].length;
    } else {
      throw new Error(`Bad JSONPath near "${path.slice(i)}"`);
    }
  }
  return tokens;
}

export function query(data, path) {
  const tokens = tokenize(path);
  let cur = data;
  for (const t of tokens) {
    if (cur == null) return { found: false, value: undefined };
    if (t === 'length' && (Array.isArray(cur) || typeof cur === 'string')) {
      cur = cur.length;
      continue;
    }
    if (typeof t === 'number') {
      if (!Array.isArray(cur) || t >= cur.length) return { found: false, value: undefined };
      cur = cur[t];
    } else {
      if (typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, t)) return { found: false, value: undefined };
      cur = cur[t];
    }
  }
  return { found: true, value: cur };
}
