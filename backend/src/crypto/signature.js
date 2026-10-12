import crypto from 'node:crypto';

/**
 * ECDSA P-256 / SHA-256 signatures over raw bytes, DER encoded, base64.
 * WebCrypto-compatible: the browser verifies the same DER signature after
 * converting to IEEE P1363 (see frontend/src/lib/verify.js).
 */
export function signBytes(bytes, privateKey) {
  return crypto.sign('sha256', bytes, privateKey).toString('base64');
}

export function verifyWithPem(bytes, publicKeyPem, signatureB64) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify('sha256', bytes, key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** Alias used by services/verify.js: (bytes, signatureB64, publicKeyPem). */
export function verifyBytes(bytes, signatureB64, publicKeyPem) {
  return verifyWithPem(bytes, publicKeyPem, signatureB64);
}

/** Wrap a raw SPKI DER public key as PEM (used by keys.js for KMS GetPublicKey). */
export function derToSpkiPem(der) {
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PUBLIC KEY-----\n${b64.replace(/\n$/, '')}\n-----END PUBLIC KEY-----\n`;
}

export function derToRaw(derSig, size = 32) {
  // DER ECDSA signature (SEQUENCE of two INTEGERs r, s) -> r||s fixed width,
  // the IEEE P1363 form WebCrypto expects. Accepts base64 or a Buffer.
  const buf = Buffer.isBuffer(derSig) ? derSig : Buffer.from(derSig, 'base64');
  let offset = 2;
  if (buf[1] & 0x80) offset = 2 + (buf[1] & 0x7f);
  const readInt = (o) => {
    const len = buf[o + 1]; // short form (P-256 ints are <= 33 bytes)
    const start = o + 2;
    const skipPad = buf[start] === 0x00 && len > 1 ? 1 : 0;
    const value = buf.subarray(start + skipPad, start + len);
    return {
      value: value.length > size ? value.subarray(value.length - size) : value,
      next: start + len, // advance by the ENCODED length, not the stripped one
    };
  };
  const r = readInt(offset);
  const s = readInt(r.next);
  const pad = (v) => (v.length >= size ? v : Buffer.concat([Buffer.alloc(size - v.length), v]));
  return Buffer.concat([pad(r.value), pad(s.value)]);
}
