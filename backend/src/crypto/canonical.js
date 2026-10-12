/**
 * Canonical JSON: recursively sorted object keys, no whitespace, UTF-8.
 * This string is exactly what gets hashed (manifestHash) and signed, so the
 * frontend can reproduce it byte-for-byte for independent verification.
 */
export function canonicalize(value) {
  return stringify(value);
}

function stringify(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON cannot encode non-finite numbers');
    return JSON.stringify(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (v === undefined ? 'null' : stringify(v))).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + stringify(value[k]));
    return '{' + parts.join(',') + '}';
  }
  if (t === 'undefined') return 'null';
  throw new Error(`canonical JSON cannot encode ${t}`);
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}
