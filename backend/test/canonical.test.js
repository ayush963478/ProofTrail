// Canonical JSON (docs/API.md "Canonical manifest"): byte-stable output that
// the frontend must reproduce exactly for independent verification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { canonicalize, canonicalBytes } from '../src/crypto/canonical.js';
import { sha256Hex } from '../src/crypto/hash.js';

test('canonicalize sorts object keys recursively', () => {
  const a = { b: 1, a: { z: 1, y: [3, { q: 1, p: 2 }] } };
  assert.equal(canonicalize(a), '{"a":{"y":[3,{"p":2,"q":1}],"z":1},"b":1}');
});

test('key insertion order does not change the bytes or the hash', () => {
  const one = { filename: 'a.png', size: 10, capture: { device: 'Pixel', gps: null } };
  const two = { capture: { gps: null, device: 'Pixel' }, size: 10, filename: 'a.png' };
  const b1 = canonicalBytes(one);
  const b2 = canonicalBytes(two);
  assert.ok(b1.equals(b2));
  assert.equal(sha256Hex(b1), sha256Hex(b2));
});

test('no whitespace and UTF-8 encoded', () => {
  const obj = { note: 'café ✓', n: 1.5, t: true, nil: null };
  const s = canonicalize(obj);
  assert.equal(s, '{"n":1.5,"nil":null,"note":"café ✓","t":true}');
  assert.ok(canonicalBytes(obj).equals(Buffer.from(s, 'utf8')));
});

test('arrays keep their order (only object keys are sorted)', () => {
  assert.equal(canonicalize({ xs: [3, 1, 2] }), '{"xs":[3,1,2]}');
  assert.equal(canonicalize([1, 'two', false]), '[1,"two",false]');
});

test('undefined object properties are omitted; undefined array items become null', () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalize([undefined]), '[null]');
});

test('dates serialize as ISO strings', () => {
  const d = new Date('2026-01-02T03:04:05.000Z');
  assert.equal(canonicalize({ at: d }), '{"at":"2026-01-02T03:04:05.000Z"}');
});

test('non-finite numbers are rejected (they would break round-tripping)', () => {
  assert.throws(() => canonicalize({ x: NaN }), /non-finite/);
  assert.throws(() => canonicalize({ x: Infinity }), /non-finite/);
});

test('nested structures hash identically regardless of construction order', () => {
  const m1 = { version: '1.0', capture: { url: 'https://x', device: null }, sha256: 'ab'.repeat(32) };
  const m2 = { sha256: 'ab'.repeat(32), capture: { device: null, url: 'https://x' }, version: '1.0' };
  assert.equal(sha256Hex(canonicalBytes(m1)), sha256Hex(canonicalBytes(m2)));
});
