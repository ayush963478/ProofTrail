// ECDSA P-256 signatures (src/crypto/signature.js) + WebCrypto cross-check.
//
// The contract stores `signature.value` as base64 DER (see docs/API.md) while
// browsers verify with WebCrypto, which wants IEEE P1363 (r||s) — derToRaw()
// is the documented bridge, so it is exercised against both verifiers here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import './helpers.js';
import { signBytes, verifyWithPem, verifyBytes, derToRaw, derToSpkiPem } from '../src/crypto/signature.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'sec1', format: 'pem' },
});

const message = Buffer.from('{"evidenceId":"ev_demo","sha256":"' + 'ab'.repeat(32) + '"}', 'utf8');

test('sign + verify round trip (DER, base64)', () => {
  const sigB64 = signBytes(message, privateKey);
  assert.equal(typeof sigB64, 'string');
  const der = Buffer.from(sigB64, 'base64');
  assert.equal(der[0], 0x30, 'signature is a DER SEQUENCE');
  assert.ok(verifyWithPem(message, publicKey, sigB64));
  assert.ok(verifyBytes(message, sigB64, publicKey), 'alias used by services/verify.js');
});

test('tampered message, wrong key or mangled signature all fail', () => {
  const sigB64 = signBytes(message, privateKey);
  assert.ok(!verifyWithPem(Buffer.from('tampered'), publicKey, sigB64));

  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' });
  assert.ok(!verifyWithPem(message, otherPem, sigB64));

  const chars = sigB64.split('');
  chars[3] = chars[3] === 'A' ? 'B' : 'A';
  assert.ok(!verifyWithPem(message, publicKey, chars.join('')));
});

test('verifyWithPem never throws on malformed input (returns false)', () => {
  assert.equal(verifyWithPem(message, 'not a pem', signBytes(message, privateKey)), false);
  assert.equal(verifyWithPem(message, publicKey, '!!!notbase64!!!'), false);
});

test('derToRaw produces 64-byte r||s accepted by WebCrypto', async () => {
  const sigB64 = signBytes(message, privateKey);
  const raw = derToRaw(sigB64);
  assert.equal(raw.length, 64, 'P-256 r||s is 32 + 32 bytes');

  const key = await crypto.subtle.importKey(
    'spki',
    Buffer.from(publicKey.replace(/-----[^-]+-----|\s+/g, ''), 'base64'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    raw,
    message,
  );
  assert.equal(ok, true, 'WebCrypto accepts the DER->raw converted signature');

  const bad = Buffer.from(raw);
  bad[0] ^= 0xff;
  const badOk = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bad, message);
  assert.equal(badOk, false);
});

test('derToSpkiPem wraps raw SPKI DER as a usable PEM', () => {
  const spkiDer = Buffer.from(
    publicKey.replace(/-----[^-]+-----|\s+/g, ''),
    'base64',
  );
  const pem = derToSpkiPem(spkiDer);
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----/);
  assert.ok(verifyWithPem(message, pem, signBytes(message, privateKey)));
});
