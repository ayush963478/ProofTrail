import crypto from 'node:crypto';

export function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

export function sha256Hex(buf) {
  return sha256Bytes(buf).toString('hex');
}

/** Incremental hashing for large streams (used by vault/downloads). */
export function sha256Stream() {
  return crypto.createHash('sha256');
}

const HEX64 = /^[0-9a-f]{64}$/;
export function isSha256Hex(value) {
  return typeof value === 'string' && HEX64.test(value);
}

export const ZERO_HASH = '0'.repeat(64);
