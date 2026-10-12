// Independent verification primitives — everything the browser recomputes itself.
//
// Contract (docs/API.md "Frontend-independent verification"):
//   1. sha256(local file) === evidence.sha256
//   2. sha256(utf8(canonicalJson(manifest))) === proof.manifestHash
//   3. ECDSA P-256 / SHA-256 verify of signature.value (base64 DER) over the
//      canonical manifest bytes with proof.signature.publicKeyPem
//   4. manifest.timestamp.token === proof.timestamp.token
//
// canonicalJson must match the backend byte-for-byte: recursively sorted object
// keys, no whitespace, UTF-8.

import { sha256Hex, sameHex } from './hash.js';

/** Recursively canonical JSON: object keys sorted lexicographically, no whitespace. */
export function canonicalJson(value) {
  if (value === undefined || value === null) return 'null';
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (type === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (type === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

/** Canonical manifest bytes (UTF-8) — exactly what was signed. */
export function canonicalManifestBytes(manifest) {
  return new TextEncoder().encode(canonicalJson(manifest));
}

/** sha256(utf8(canonicalJson(manifest))) -> lowercase hex */
export async function computeManifestHash(manifest) {
  return sha256Hex(canonicalJson(manifest));
}

/** base64 string -> Uint8Array */
export function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Extract the raw DER SPKI from a PEM (or accept raw base64 DER).
 * Handles the header/footer lines and any surrounding whitespace.
 */
export function pemToDer(pem, label = 'PUBLIC KEY') {
  const text = String(pem || '').trim();
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`);
  const m = text.match(re);
  const b64 = (m ? m[1] : text).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  if (!b64) throw new Error('Empty public key PEM');
  return base64ToBytes(b64);
}

function pad32(bytes) {
  // Strip leading zeros, then left-pad (or trim) to exactly 32 bytes.
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  let v = bytes.subarray(start);
  if (v.length > 32) v = v.subarray(v.length - 32);
  const out = new Uint8Array(32);
  out.set(v, 32 - v.length);
  return out;
}

/**
 * WebCrypto expects ECDSA signatures as raw r||s (64 bytes for P-256), but
 * backends emit DER (as documented: "base64 DER"). Convert DER -> raw.
 * If the input is already 64 bytes it is passed through unchanged.
 */
export function derEcdsaToRaw(der) {
  const bytes =
    der instanceof Uint8Array
      ? der
      : der instanceof ArrayBuffer
        ? new Uint8Array(der)
        : base64ToBytes(der);
  if (bytes.length === 64) return bytes;
  let off = 0;
  if (bytes[off] !== 0x30) throw new Error('Invalid DER signature: expected SEQUENCE');
  off += 1;
  let len = bytes[off];
  off += 1;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i += 1) {
      len = (len << 8) | bytes[off];
      off += 1;
    }
  }
  if (bytes[off] !== 0x02) throw new Error('Invalid DER signature: expected INTEGER r');
  off += 1;
  const rLen = bytes[off];
  off += 1;
  const r = bytes.subarray(off, off + rLen);
  off += rLen;
  if (bytes[off] !== 0x02) throw new Error('Invalid DER signature: expected INTEGER s');
  off += 1;
  const sLen = bytes[off];
  off += 1;
  const s = bytes.subarray(off, off + sLen);
  const raw = new Uint8Array(64);
  raw.set(pad32(r), 0);
  raw.set(pad32(s), 32);
  return raw;
}

/**
 * Verify an ECDSA P-256 / SHA-256 signature over the canonical manifest bytes
 * using the PEM public key (SPKI) from GET /public/keys/{keyId} (or embedded
 * in the public verify response).
 *
 * @returns {Promise<boolean>} true only if the signature is valid.
 * @throws on malformed key/signature input.
 */
export async function verifyManifestSignature(manifest, signatureValue, publicKeyPem) {
  if (!manifest || !signatureValue || !publicKeyPem) {
    throw new Error('Missing manifest, signature or public key');
  }
  const spki = pemToDer(publicKeyPem, 'PUBLIC KEY');
  const key = await crypto.subtle.importKey(
    'spki',
    spki.buffer.slice(spki.byteOffset, spki.byteOffset + spki.byteLength),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const signature = derEcdsaToRaw(signatureValue);
  const data = canonicalManifestBytes(manifest);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data);
}

/**
 * Run all four independent browser checks for one evidence record.
 *
 * @param {object} opts
 * @param {object} opts.evidence  { sha256, filename, ... }
 * @param {object} opts.proof     { manifest, manifestHash, signature, timestamp, ... }
 * @param {File}   [opts.file]    locally selected original file (optional)
 * @returns rows: [{ key, label, server, browser, status, detail }]
 *   status: 'pass' | 'fail' | 'pending'
 */
export async function runBrowserChecks({ evidence, proof, file = null, serverChecks = [] }) {
  const rows = [];
  const serverCheck = (name) => serverChecks.find((c) => c.name === name);

  // 1. File hash (needs a local file)
  if (file) {
    const localHash = await sha256Hex(file);
    const match = sameHex(localHash, evidence?.sha256);
    rows.push({
      key: 'file_hash',
      label: 'File SHA-256',
      server: evidence?.sha256 || '—',
      browser: localHash,
      status: match ? 'pass' : 'fail',
      detail: match
        ? 'Local file hash matches the sealed hash.'
        : 'Local file hash does NOT match the sealed hash — different bytes.',
    });
  } else {
    rows.push({
      key: 'file_hash',
      label: 'File SHA-256',
      server: evidence?.sha256 || '—',
      browser: null,
      status: 'pending',
      detail: 'Select the original file to compute its hash locally.',
    });
  }

  if (!proof || !proof.manifest) {
    rows.push({
      key: 'manifest_hash',
      label: 'Manifest hash',
      server: proof?.manifestHash || '—',
      browser: null,
      status: 'pending',
      detail: 'No proof available.',
    });
    return rows;
  }

  // 2. Manifest hash recompute
  let manifestHash = null;
  let manifestOk = false;
  let manifestError = null;
  try {
    manifestHash = await computeManifestHash(proof.manifest);
    manifestOk = sameHex(manifestHash, proof.manifestHash);
  } catch (e) {
    manifestError = e.message;
  }
  rows.push({
    key: 'manifest_hash',
    label: 'Manifest hash (canonical JSON → SHA-256)',
    server: proof.manifestHash,
    browser: manifestHash,
    status: manifestHash ? (manifestOk ? 'pass' : 'fail') : 'fail',
    detail:
      manifestError ||
      (manifestOk
        ? 'Canonical manifest hashes to the recorded manifestHash.'
        : 'Recomputed manifest hash differs from the recorded value.'),
  });

  // 3. Signature
  let sigOk = false;
  let sigError = null;
  try {
    sigOk = await verifyManifestSignature(
      proof.manifest,
      proof.signature?.value,
      proof.signature?.publicKeyPem
    );
    if (!sigOk) sigError = 'Signature did not verify against the canonical bytes.';
  } catch (e) {
    sigError = e.message;
  }
  const sigServer = serverCheck('signature');
  rows.push({
    key: 'signature',
    label: `ECDSA signature (${proof.signature?.keyId || 'key'}, P-256/SHA-256)`,
    server: sigServer ? (sigServer.passed ? 'valid' : 'invalid') : 'valid',
    browser: sigOk ? 'valid' : 'invalid',
    status: sigOk ? 'pass' : 'fail',
    detail: sigOk
      ? 'Signature verified with WebCrypto against the canonical manifest bytes.'
      : sigError || 'Signature verification failed.',
  });

  // 4. Timestamp token equality
  const tsEqual =
    Boolean(proof.manifest?.timestamp?.token) &&
    proof.manifest.timestamp.token === proof.timestamp?.token;
  const tsServer = serverCheck('timestamp');
  rows.push({
    key: 'timestamp',
    label: 'Timestamp token (manifest vs proof)',
    server: tsServer ? (tsServer.passed ? 'present' : 'missing') : proof.timestamp?.mode || '—',
    browser: tsEqual ? 'identical' : 'different',
    status: tsEqual ? 'pass' : 'fail',
    detail: tsEqual
      ? 'The token inside the signed manifest equals the timestamp token in the proof.'
      : 'Timestamp tokens differ — the manifest was altered after sealing.',
  });

  return rows;
}
