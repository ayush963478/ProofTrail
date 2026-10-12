// SHA-256 helpers (src/crypto/hash.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import './helpers.js';
import { sha256Bytes, sha256Hex, sha256Stream, isSha256Hex, ZERO_HASH } from '../src/crypto/hash.js';

test('sha256Hex matches node:crypto for empty and non-empty input', () => {
  assert.equal(sha256Hex(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const data = Buffer.from('ProofTrail', 'utf8');
  assert.equal(sha256Hex(data), crypto.createHash('sha256').update(data).digest('hex'));
});

test('sha256Bytes returns a 32-byte buffer equal to sha256Hex', () => {
  const data = Buffer.from('abc');
  const b = sha256Bytes(data);
  assert.ok(Buffer.isBuffer(b));
  assert.equal(b.length, 32);
  assert.equal(b.toString('hex'), sha256Hex(data));
});

test('sha256Stream hashes incrementally across chunks', () => {
  const h = sha256Stream();
  h.update('hello ');
  h.update('world');
  assert.equal(h.digest('hex'), sha256Hex(Buffer.from('hello world')));
});

test('isSha256Hex accepts exactly 64 lowercase hex chars', () => {
  assert.ok(isSha256Hex('a1b2'.repeat(16)));
  assert.ok(!isSha256Hex('A1B2'.repeat(16)), 'uppercase rejected');
  assert.ok(!isSha256Hex('a1b2'.repeat(15)), '60 chars rejected');
  assert.ok(!isSha256Hex('a1b2'.repeat(17)), '68 chars rejected');
  assert.ok(!isSha256Hex(null));
  assert.ok(!isSha256Hex(12345));
  assert.ok(!isSha256Hex('z'.repeat(64)));
});

test('ZERO_HASH is 64 zeros (ledger genesis prevHash)', () => {
  assert.equal(ZERO_HASH.length, 64);
  assert.match(ZERO_HASH, /^0{64}$/);
});
