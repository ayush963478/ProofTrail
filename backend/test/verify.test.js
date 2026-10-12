// Public verification (docs/API.md GET /public/verify/{token}) — the six fixed
// checks, plus tamper resistance: modified manifest, broken ledger link and a
// rewritten vault object must all be caught.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import './helpers.js';
import { ACTOR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { getDb } from '../src/services/db.js';
import { createEvidence, receiveUpload } from '../src/services/evidence.js';
import { runSeal } from '../src/services/seal.js';
import { evidenceChecks, timestampedManifestBytes, aggregateChecks, publicEvidenceView } from '../src/services/verify.js';
import { anchorNow } from '../src/services/anchor.js';
import { validateShare, createShare } from '../src/services/share.js';
import * as ledger from '../src/services/ledger.js';
import { sha256Hex } from '../src/crypto/hash.js';
import { canonicalBytes } from '../src/crypto/canonical.js';

const cfg = loadConfig();
const db = getDb(cfg);

const CHECK_NAMES = ['hash_present', 'manifest_integrity', 'signature', 'timestamp', 'ledger_chain', 'anchor'];

const BYTES = Buffer.from('evidence for verification checks\n', 'utf8');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let evId;
let shareToken;

before(async () => {
  const created = await createEvidence(ACTOR, {
    type: 'page',
    filename: 'page.html',
    mimeType: 'text/html',
    size: BYTES.length,
    clientSha256: sha(BYTES),
    captureMethod: 'cloud_url',
    capture: { url: 'https://example.com/post', device: 'Chrome', clientTime: '2026-10-06T10:00:00Z' },
  }, { cfg, db });
  evId = created.id;
  await receiveUpload(evId, { headers: { 'x-client-sha256': sha(BYTES) }, bytes: BYTES, cfg, db });
  await runSeal(evId, cfg, db);
  const share = await createShare({ scope: 'evidence', targetId: evId }, cfg, db);
  shareToken = share.token;
});

test('all six checks pass on a freshly sealed item', async () => {
  const ev = await db.getEvidence(evId);
  const { proof, checks, checksPassed, checksTotal } = await evidenceChecks(ev, { deep: true }, cfg, db);

  assert.equal(checksTotal, 6);
  assert.equal(checksPassed, 6, JSON.stringify(checks, null, 2));
  assert.deepEqual(checks.map((c) => c.name), CHECK_NAMES);
  for (const c of checks) {
    assert.equal(c.passed, true, `${c.name}: ${c.detail}`);
    assert.ok(typeof c.detail === 'string' && c.detail.length > 0, 'every check has a human-readable detail');
  }

  // proof envelope returned to the verify page
  assert.equal(proof.manifestHash, sha256Hex(canonicalBytes(proof.manifest)));
  assert.ok(proof.signature.publicKeyPem.includes('BEGIN PUBLIC KEY'));
  assert.equal(proof.timestamp.verified, true);
  assert.equal(proof.ledger.chainVerified, true);
  assert.equal(proof.ledger.deepChecked, true);
  assert.equal(proof.ledger.seq, '000000000001');
});

test('the anchor check passes as "pending batch" before any anchor is published', async () => {
  const ev = await db.getEvidence(evId);
  const { checks } = await evidenceChecks(ev, {}, cfg, db);
  const anchor = checks.find((c) => c.name === 'anchor');
  assert.equal(anchor.passed, true);
  assert.match(anchor.detail, /pending batch/);
});

test('after anchorNow the merkle inclusion proof is verified against the root', async () => {
  const batch = await anchorNow(cfg, db);
  assert.ok(batch.root, JSON.stringify(batch));
  assert.equal(batch.leafCount, 1);

  const ev = await db.getEvidence(evId);
  const { checks, proof } = await evidenceChecks(ev, {}, cfg, db);
  const anchor = checks.find((c) => c.name === 'anchor');
  assert.equal(anchor.passed, true, anchor.detail);
  assert.match(anchor.detail, /included in root/);
  assert.equal(proof.anchor.root, batch.root);
  assert.ok(Array.isArray(proof.anchor.merkleProof));

  // the published root is queryable (GET /public/anchors/{root} reads this)
  const item = await db.getAnchorByRoot(batch.root);
  assert.ok(item);
  assert.equal(item.fromSeq, '000000000001');
});

test('tampering with the signed manifest breaks manifest_integrity', async () => {
  const ev = await db.getEvidence(evId);
  const tampered = {
    ...ev,
    proof: { ...ev.proof, manifest: { ...ev.proof.manifest, filename: 'swapped.png' } },
  };
  const { checks, checksPassed } = await evidenceChecks(tampered, {}, cfg, db);
  const mi = checks.find((c) => c.name === 'manifest_integrity');
  assert.equal(mi.passed, false);
  assert.match(mi.detail, /mismatch/);
  // signature also fails — it covers the canonical manifest
  assert.equal(checks.find((c) => c.name === 'signature').passed, false);
  assert.ok(checksPassed < 6);
});

test('tampering with a ledger entry breaks ledger_chain', async () => {
  const ev = await db.getEvidence(evId);
  const entry = await ledger.get(ev.proof.ledger.seq, cfg, db);
  const forged = { ...entry, manifestHash: 'ee'.repeat(32) };
  // the local store refuses in-place edits, so verify the detection function
  // against the forged copy as checkEntry would see it
  const { checkEntry } = await import('../src/services/ledger.js');
  const r = await checkEntry(forged, { deep: true }, cfg, db);
  // deep mode verifies the on-disk chain (intact) and then requires the exact
  // entry hash to be present — the forged hash is not
  assert.equal(r.passed, false);

  const nonDeep = await checkEntry(forged, { deep: false }, cfg, db);
  assert.equal(nonDeep.passed, false);
  assert.match(nonDeep.detail, /entryHash recomputation/);
});

test('a forged proof.manifestHash no longer matches the ledger row', async () => {
  const ev = await db.getEvidence(evId);
  const tampered = { ...ev, proof: { ...ev.proof, manifestHash: 'ab'.repeat(32) } };
  const { checks } = await evidenceChecks(tampered, {}, cfg, db);
  const lc = checks.find((c) => c.name === 'ledger_chain');
  assert.equal(lc.passed, false);
  assert.match(lc.detail, /does not match proof\.manifestHash/);
});

test('a rewritten vault object is caught by re-hashing the stored bytes', async () => {
  const ev = await db.getEvidence(evId);
  const { evidenceBytes } = await import('../src/services/seal.js');
  const stored = await evidenceBytes(ev, cfg);
  assert.ok(stored.equals(BYTES));
  assert.equal(sha256Hex(stored), ev.proof.manifest.sha256);

  // simulate an attacker rewriting the stored object
  const key = path.join(cfg.vaultDir, ev.storageKey);
  const original = fs.readFileSync(key);
  try {
    fs.writeFileSync(key, Buffer.concat([original, Buffer.from('EXTRA')]));
    const rewritten = await evidenceBytes({ ...ev }, cfg);
    assert.notEqual(sha256Hex(rewritten), ev.proof.manifest.sha256,
      'rewritten bytes no longer match the sealed manifest hash');
    assert.notEqual(sha256Hex(rewritten), ev.sha256);
  } finally {
    fs.writeFileSync(key, original);
  }
  // restored
  assert.equal(sha256Hex(await evidenceBytes(ev, cfg)), ev.sha256);
});

test('an unsealed item returns proof:null with explanatory failing checks', async () => {
  const created = await createEvidence(ACTOR, {
    type: 'file',
    filename: 'unsealed.bin',
    mimeType: 'application/octet-stream',
    size: 4,
    clientSha256: sha(Buffer.from('abcd')),
    captureMethod: 'upload',
  }, { cfg, db });
  const ev = await db.getEvidence(created.id);
  const { proof, checks, checksPassed, checksTotal } = await evidenceChecks(ev, {}, cfg, db);
  assert.equal(proof, null);
  assert.equal(checksTotal, 6);
  assert.equal(checksPassed, 0, 'nothing can pass before the server has sealed bytes');
  assert.equal(checks.find((c) => c.name === 'hash_present').passed, false);
  assert.match(checks.find((c) => c.name === 'hash_present').detail, /no server-computed SHA-256/);
  assert.match(checks.find((c) => c.name === 'manifest_integrity').detail, /not been sealed/);
  assert.match(checks.find((c) => c.name === 'anchor').detail, /not been sealed/);
});

test('public share token validates; unknown/revoked tokens are rejected', async () => {
  const share = await validateShare(shareToken, cfg, db);
  assert.equal(share.scope, 'evidence');
  assert.equal(share.targetId, evId);

  await assert.rejects(() => validateShare('not-a-real-token', cfg, db), (e) => e.code === 'not_found');
  const revoked = await createShare({ scope: 'evidence', targetId: evId }, cfg, db);
  await db.updateShare(revoked.id, { revokedAt: new Date().toISOString() });
  await assert.rejects(() => validateShare(revoked.token, cfg, db), (e) => e.code === 'gone');

  const expired = await createShare({ scope: 'evidence', targetId: evId, expiresInHours: 1 }, cfg, db);
  await db.updateShare(expired.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(() => validateShare(expired.token, cfg, db), (e) => e.code === 'gone');
});

test('publicEvidenceView exposes only the documented public fields', async () => {
  const ev = await db.getEvidence(evId);
  const view = publicEvidenceView(ev);
  assert.deepEqual(Object.keys(view).sort(), [
    'capture', 'captureMethod', 'filename', 'id', 'sealedAt', 'sha256', 'size', 'type',
  ]);
  assert.ok(!('proof' in view), 'raw proof is not exposed by the public view');
  assert.equal(view.sealedAt, ev.proof.sealedAt);
  assert.equal(view.capture.gps, null);
});

test('aggregateChecks passes only when every item passes', () => {
  const item = (name, passed) => ({
    evidence: { filename: name },
    checks: CHECK_NAMES.map((n) => ({ name: n, passed, detail: `${name} ${n}` })),
  });
  const allPass = aggregateChecks([item('a.png', true), item('b.png', true)]);
  assert.equal(allPass.checksTotal, 6);
  assert.equal(allPass.checksPassed, 6);

  const oneBad = aggregateChecks([item('a.png', true), item('b.png', false)]);
  assert.equal(oneBad.checksPassed, 0, 'a check fails globally if any item fails it');
  assert.equal(oneBad.checks.find((c) => c.name === 'anchor').passed, false);
  assert.match(oneBad.checks.find((c) => c.name === 'anchor').detail, /b\.png/);

  const mixed = aggregateChecks([
    { evidence: { filename: 'a.png' }, checks: CHECK_NAMES.map((n) => ({ name: n, passed: true, detail: 'ok' })) },
    { evidence: { filename: 'b.png' }, checks: [{ name: 'anchor', passed: false, detail: 'bad root' }] },
  ]);
  // the union of check names is aggregated; names missing from one item do not
  // make that item fail
  assert.equal(mixed.checksTotal, 6);
  assert.equal(mixed.checksPassed, 5);
  assert.equal(mixed.checks.find((c) => c.name === 'anchor').passed, false);
  assert.equal(mixed.checks.find((c) => c.name === 'signature').passed, true);
});
