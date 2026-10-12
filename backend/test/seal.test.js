// Seal pipeline end-to-end (docs/API.md POST /evidence/{id}/seal).
//
// Covers: upload contract, 422 hash_mismatch on the request path, the full
// seal (manifest -> timestamp -> signature -> ledger -> vault) and the fact
// that a sealed record is idempotent.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import './helpers.js';
import { ACTOR, DATA_DIR } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { getDb } from '../src/services/db.js';
import { createEvidence, receiveUpload, requestSeal, getEvidenceOwned } from '../src/services/evidence.js';
import { runSeal, verifyStagedHash, evidenceBytes } from '../src/services/seal.js';
import { canonicalBytes } from '../src/crypto/canonical.js';
import { sha256Hex } from '../src/crypto/hash.js';
import { verifyBytes } from '../src/crypto/signature.js';
import { getPublicKey } from '../src/crypto/keys.js';
import * as ledger from '../src/services/ledger.js';

const cfg = loadConfig();
const db = getDb(cfg);

const BYTES = Buffer.from('ProofTrail sealed evidence payload — chain of custody.\n', 'utf8');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let evId;

before(async () => {
  const created = await createEvidence(ACTOR, {
    type: 'file',
    filename: 'contract.pdf',
    mimeType: 'application/pdf',
    size: BYTES.length,
    clientSha256: sha(BYTES),
    captureMethod: 'upload',
    capture: { device: 'Pixel 8', url: 'https://example.com/doc', clientTime: '2026-10-06T09:00:00Z' },
  }, { cfg, db, ip: '127.0.0.1' });
  evId = created.id;
  assert.equal(created.status, 'pending_upload');
  assert.match(created.uploadUrl, /\/evidence\/upload\//);
  assert.equal(created.uploadHeaders['x-client-sha256'], sha(BYTES));
});

test('upload requires the x-client-sha256 header and a matching hash', async () => {
  await assert.rejects(
    () => receiveUpload(evId, { headers: {}, bytes: BYTES, cfg, db }),
    (e) => e.code === 'validation_error',
  );
  await assert.rejects(
    () => receiveUpload(evId, { headers: { 'x-client-sha256': sha(Buffer.from('other')) }, bytes: BYTES, cfg, db }),
    (e) => e.code === 'validation_error',
  );
  await assert.rejects(
    () => receiveUpload('ev_does_not_exist', { headers: { 'x-client-sha256': sha(BYTES) }, bytes: BYTES, cfg, db }),
    (e) => e.code === 'not_found',
  );
});

test('upload of an empty body is rejected', async () => {
  await assert.rejects(
    () => receiveUpload(evId, { headers: { 'x-client-sha256': sha(BYTES) }, bytes: Buffer.alloc(0), cfg, db }),
    (e) => e.code === 'validation_error',
  );
});

test('a valid upload moves the record to uploaded', async () => {
  await receiveUpload(evId, { headers: { 'x-client-sha256': sha(BYTES) }, bytes: BYTES, cfg, db });
  const ev = await getEvidenceOwned(evId, ACTOR, cfg, db);
  assert.equal(ev.status, 'uploaded');
  assert.equal(ev.size, BYTES.length);
  assert.equal(sha(BYTES), ev.clientSha256);
});

test('seal of a staged upload whose bytes were swapped -> 422 hash_mismatch', async () => {
  // second evidence whose clientSha256 does NOT match what we will store
  const created = await createEvidence(ACTOR, {
    type: 'photo',
    filename: 'IMG_0001.jpg',
    mimeType: 'image/jpeg',
    size: 11,
    clientSha256: sha(Buffer.from('WRONGBYTES!')), // client hashes what it uploads
    captureMethod: 'upload',
  }, { cfg, db });
  const wrong = Buffer.from('WRONGBYTES!');
  await receiveUpload(created.id, { headers: { 'x-client-sha256': sha(wrong) }, bytes: wrong, cfg, db });
  // simulate the client-reported hash being wrong relative to what is staged
  await db.updateEvidence(created.id, { clientSha256: sha(BYTES) });

  await assert.rejects(
    () => requestSeal(created.id, ACTOR, { cfg, db, ip: '127.0.0.1' }),
    (e) => e.code === 'hash_mismatch' && e.status === 422,
  );
  const ev = await db.getEvidence(created.id);
  assert.equal(ev.status, 'failed');
  assert.match(ev.sealError, /hash_mismatch/);
  assert.equal(ev.hashMatched, false);

  // and runSeal reports the same failure
  await assert.rejects(() => runSeal(created.id, cfg, db), (e) => e.code === 'hash_mismatch');
});

test('sealing with no staged upload -> 409 conflict', async () => {
  const created = await createEvidence(ACTOR, {
    type: 'text',
    filename: 'note.txt',
    mimeType: 'text/plain',
    size: 5,
    clientSha256: sha(Buffer.from('hello')),
    captureMethod: 'upload',
  }, { cfg, db });
  await assert.rejects(() => requestSeal(created.id, ACTOR, { cfg, db }), (e) => e.code === 'conflict');
});

test('full seal: manifest + timestamp + signature + ledger + vault', async () => {
  await runSeal(evId, cfg, db);
  const ev = await getEvidenceOwned(evId, ACTOR, cfg, db);

  assert.equal(ev.status, 'sealed');
  assert.equal(ev.sealError, null);
  assert.equal(ev.hashMatched, true);
  assert.equal(ev.sha256, sha(BYTES), 'server hash equals sha256(staged bytes)');

  const proof = ev.proof;
  assert.ok(proof, 'proof present');
  assert.ok(proof.sealedAt);

  // manifest field set per API.md
  const m = proof.manifest;
  assert.deepEqual(Object.keys(m).sort(), [
    'capture', 'captureMethod', 'evidenceId', 'filename', 'serverTime',
    'sha256', 'size', 'timestamp', 'type', 'version',
  ]);
  assert.equal(m.evidenceId, evId);
  assert.equal(m.filename, 'contract.pdf');
  assert.equal(m.sha256, sha(BYTES));
  assert.equal(m.size, BYTES.length);
  assert.equal(m.version, '1.0');

  // manifestHash = sha256(canonical manifest incl. timestamp)
  assert.equal(proof.manifestHash, sha256Hex(canonicalBytes(m)));

  // signature over the canonical manifest verifies with the published key
  const key = await getPublicKey(proof.signature.keyId, cfg);
  assert.ok(verifyBytes(canonicalBytes(m), proof.signature.value, key.publicKeyPem));
  assert.equal(proof.signature.algorithm, 'ECDSA_SHA_256');

  // timestamp token covers the manifest WITHOUT its timestamp field (no
  // circularity — see docs/API.md timestamp rule)
  const { timestampedManifestBytes } = await import('../src/services/verify.js');
  const stamped = timestampedManifestBytes(m);
  assert.deepEqual(JSON.parse(stamped.toString('utf8')), JSON.parse(canonicalBytes({ ...m, timestamp: undefined }).toString('utf8')));
  assert.notEqual(stamped.toString('utf8'), canonicalBytes(m).toString('utf8'));

  // ledger entry matches the proof
  const entry = await ledger.get(proof.ledger.seq, cfg, db);
  assert.ok(entry);
  assert.equal(entry.manifestHash, proof.manifestHash);
  assert.equal(entry.evidenceId, evId);
  assert.equal(entry.prevHash, proof.ledger.prevHash);
  assert.equal(entry.entryHash, proof.ledger.entryHash);
  assert.equal(entry.seq.length, 12);

  // vault holds the original bytes (write-once)
  const stored = await evidenceBytes(ev, cfg);
  assert.ok(stored.equals(BYTES), 'vault bytes identical to the upload');
});

test('sealing twice is idempotent (record unchanged)', async () => {
  const before = await getEvidenceOwned(evId, ACTOR, cfg, db);
  const again = await runSeal(evId, cfg, db);
  assert.equal(again.proof.sealedAt, before.proof.sealedAt);
  assert.equal(again.proof.ledger.seq, before.proof.ledger.seq);
  await assert.rejects(() => requestSeal(evId, ACTOR, { cfg, db }), (e) => e.code === 'conflict');
});

test('verifyStagedHash conflicts once staging has been consumed by the seal', async () => {
  // sealing moves staging -> vault (write-once), so the staged object is gone
  await assert.rejects(() => verifyStagedHash(evId, cfg, db), (e) => e.code === 'conflict');
  // but the sealed bytes still come back from the vault via evidenceBytes
  const ev = await getEvidenceOwned(evId, ACTOR, cfg, db);
  assert.ok((await evidenceBytes(ev, cfg)).equals(BYTES));
});

test('a seal-audit record exists for the sealed item', async () => {
  const rows = await db.listAudit(evId);
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes('create'));
  assert.ok(actions.includes('seal'));
});

test('DATA_DIR is the isolated test directory', () => {
  assert.equal(cfg.dataDir, DATA_DIR);
});
