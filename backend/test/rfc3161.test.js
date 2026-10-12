// RFC 3161 time-stamping client + verifier against the committed OpenSSL
// fixtures in test/fixtures (regenerate with `node test/fixtures/generate.js`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import './helpers.js';
import { FIXTURES } from './helpers.js';
import {
  OID,
  derOid,
  parseTimeStampResponse,
  parseTstInfo,
  genTimeToIso,
  verifyTimestamp,
  buildTimeStampReq,
  createTimeStampRequest,
  verifyTimestampResponse,
} from '../src/crypto/rfc3161.js';

const message = fs.readFileSync(path.join(FIXTURES, 'message.bin'));
const token = fs.readFileSync(path.join(FIXTURES, 'resp.tsr'));
const tsaCertPem = fs.readFileSync(path.join(FIXTURES, 'tsa.crt'), 'utf8');
const fixtureReq = fs.readFileSync(path.join(FIXTURES, 'req.tsq'));
const FIXTURE_NONCE = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');

test('OID encoding: sha256 is 2.16.840.1.101.3.4.2.1 -> 60 86 48 01 65 03 04 02 01', () => {
  const der = derOid(OID.sha256);
  assert.equal(der.toString('hex'), '0609608648016503040201');
});

test('buildTimeStampReq reproduces the committed request byte-for-byte', () => {
  const digest = crypto.createHash('sha256').update(message).digest();
  const req = buildTimeStampReq({ hashedMessage: digest, nonce: FIXTURE_NONCE });
  assert.ok(req.equals(fixtureReq), 'our encoder must match req.tsq exactly');
});

test('parseTimeStampResponse reads a granted status + token', () => {
  const resp = parseTimeStampResponse(token);
  assert.ok(resp.status === 0 || resp.status === 1, 'granted/grantedWithMods');
  assert.ok(resp.tokenTlv, 'token present');
});

test('parseTimeStampResponse rejects a rejection response with a useful message', () => {
  // status=2 (rejection) + statusString "no time stamp token"
  const bad = Buffer.from('30373035020102302c0c2a4d6573736167652064696765737420616c676f726974686d206973206e6f7420737570706f727465642e03020780', 'hex');
  assert.throws(() => parseTimeStampResponse(bad), /rejection|status/);
});

test('parseTstInfo reads version, policy, imprint, serial, genTime and nonce', () => {
  const resp = parseTimeStampResponse(token);
  // pull eContent out of the CMS ContentInfo
  function tlv(buf, off = 0) {
    const tag = buf[off];
    let len = buf[off + 1];
    let pos = off + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[pos++];
    }
    return { tag, content: buf.subarray(pos, pos + len) };
  }
  function all(buf) {
    const out = [];
    let off = 0;
    while (off < buf.length) {
      const t = tlv(buf, off);
      out.push(t);
      off += t.content.length + (buf[off + 1] & 0x80 ? 2 + (buf[off + 1] & 0x7f) : 2);
    }
    return out;
  }
  const ci = all(resp.tokenTlv.content);
  const sd = all(ci[1].content)[0];
  let eContent;
  for (const item of all(all(sd.content)[2].content)) {
    if (item.tag === 0xa0) eContent = tlv(item.content, 0).content;
  }
  const tst = parseTstInfo(eContent);
  assert.equal(tst.version, 1);
  assert.equal(tst.policy, '1.2.3.4.1');
  assert.equal(tst.imprintOid, OID.sha256);
  assert.equal(tst.imprint.toString('hex'), crypto.createHash('sha256').update(message).digest('hex'));
  assert.ok(tst.serial && tst.serial.length >= 1, 'serial present (never read as the nonce)');
  assert.equal(tst.nonce.toString('hex'), '0102030405060708090a0b0c0d0e0f10');
  assert.match(tst.genTime, /^\d{14}Z$/);
});

test('verifyTimestamp: full pass against the OpenSSL fixture', () => {
  const out = verifyTimestamp({ message, token, tsaCertPem, expectedNonce: FIXTURE_NONCE });
  assert.equal(out.valid, true, JSON.stringify(out.checks, null, 2));
  for (const [name, c] of Object.entries(out.checks)) {
    assert.equal(c.passed, true, `${name}: ${c.detail}`);
  }
  assert.equal(out.policy, '1.2.3.4.1');
  assert.match(out.genTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(out.signerSerial, /^[0-9a-f]+$/);
});

test('verifyTimestamp: tampered message fails the imprint check', () => {
  const out = verifyTimestamp({ message: Buffer.from('tampered'), token, tsaCertPem });
  assert.equal(out.valid, false);
  assert.equal(out.checks.imprint.passed, false);
  // signature over the token itself is still fine
  assert.equal(out.checks.signature.passed, true);
});

test('verifyTimestamp: wrong expected nonce fails only the nonce check', () => {
  const out = verifyTimestamp({ message, token, tsaCertPem, expectedNonce: Buffer.alloc(16, 7) });
  assert.equal(out.valid, false);
  assert.equal(out.checks.nonce.passed, false);
  assert.equal(out.checks.imprint.passed, true);
});

test('verifyTimestamp: a different TSA certificate fails the chain check', () => {
  // Build an impostor self-signed cert so the configured TSA public key differs.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prooftrail-tsa-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'),
      '-sha256', '-days', '1', '-subj', '/CN=Not The TSA']);
    const impostor = fs.readFileSync(path.join(tmp, 'c.pem'), 'utf8');
    const out = verifyTimestamp({ message, token, tsaCertPem: impostor });
    assert.equal(out.valid, false);
    assert.equal(out.checks.chain.passed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verifyTimestamp: corrupted token fails parse (never throws)', () => {
  const out = verifyTimestamp({ message, token: Buffer.from('not der at all'), tsaCertPem });
  assert.equal(out.valid, false);
  assert.ok(out.checks.parse && out.checks.parse.passed === false);
});

test('verifyTimestamp: missing token / empty input fails parse', () => {
  assert.equal(verifyTimestamp({ message, token: Buffer.alloc(0) }).valid, false);
  assert.equal(verifyTimestamp({ message, token: Buffer.from([0x30, 0x00]) }).valid, false);
});

test('createTimeStampRequest embeds the sha256 digest and a random nonce', () => {
  const { request, digest, nonce } = createTimeStampRequest(message);
  assert.equal(digest.toString('hex'), crypto.createHash('sha256').update(message).digest('hex'));
  assert.equal(nonce.length, 8);
  assert.equal(request[0], 0x30, 'DER SEQUENCE');
  assert.ok(request.equals(buildTimeStampReq({ hashedMessage: digest, nonce })));
});

test('verifyTimestampResponse (service adapter) matches verifyTimestamp', () => {
  const out = verifyTimestampResponse(token, {
    expectedHash: crypto.createHash('sha256').update(message).digest(),
    expectedNonce: FIXTURE_NONCE,
    trustedCert: tsaCertPem,
  });
  assert.equal(out.genTime.length, 24);
  assert.equal(out.policy, '1.2.3.4.1');
});

test('verifyTimestampResponse rejects a wrong expected hash', () => {
  assert.throws(
    () => verifyTimestampResponse(token, { expectedHash: crypto.createHash('sha256').update('nope').digest() }),
    (e) => e.code === 'validation_error' || /imprint/i.test(e.message),
  );
});

test('genTimeToIso parses GeneralizedTime and rejects junk', () => {
  assert.equal(genTimeToIso('20261006101938Z'), '2026-10-06T10:19:38.000Z');
  assert.equal(genTimeToIso('20261006101938.500Z'), '2026-10-06T10:19:38.000Z');
  assert.equal(genTimeToIso('not-a-time'), null);
  assert.equal(genTimeToIso(null), null);
});
