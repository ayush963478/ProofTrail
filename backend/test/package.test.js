// Evidence package: zip layout, report.pdf, proof.json contract, originals byte-identical.
import './helpers.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { loadConfig } from '../src/config.js';
import { getDb } from '../src/services/db.js';
import { ACTOR } from './helpers.js';
import { createCase } from '../src/services/cases.js';
import { createEvidence, receiveUpload, getEvidenceOwned } from '../src/services/evidence.js';
import { runSeal } from '../src/services/seal.js';
import { createPackage, listPackages, getPackageOwned, downloadPackage, shapePackage } from '../src/services/package.js';

const cfg = loadConfig();
const db = getDb(cfg);

const BYTES = Buffer.from('ProofTrail packaged evidence payload — chain of custody.\n', 'utf8');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let caseRec;
let evId;
let pkg;

before(async () => {
  caseRec = await createCase(ACTOR, { title: 'Package case', description: 'packaging' }, cfg, db);
  const created = await createEvidence(ACTOR, {
    caseId: caseRec.id,
    type: 'file',
    filename: 'contract.pdf',
    mimeType: 'application/pdf',
    size: BYTES.length,
    clientSha256: sha(BYTES),
    captureMethod: 'upload',
    capture: { device: 'GX-9', clientTime: '2026-03-02T10:00:00Z' },
  }, { cfg, db, ip: '127.0.0.1' });
  evId = created.id;
  await receiveUpload(evId, { headers: { 'x-client-sha256': sha(BYTES) }, bytes: BYTES, cfg, db });
  await runSeal(evId, cfg, db);
});

test('POST /packages produces a shaped package record', async () => {
  pkg = await createPackage(ACTOR, { caseId: caseRec.id }, { cfg, db });
  assert.equal(pkg.caseId, caseRec.id);
  assert.equal(pkg.itemCount, 1);
  assert.deepEqual(pkg.evidenceIds, [evId]);
  assert.ok(pkg.size > 0);
  assert.ok(pkg.generatedAt.endsWith('Z'));
  assert.match(pkg.downloadUrl, /\/packages\/.+\/download$/);
  assert.ok(pkg.verificationUrl.includes(pkg.shareToken));
});

test('the zip contains proof.json, report.pdf, README.txt and originals/', async () => {
  const { bytes, filename } = await downloadPackage(pkg.id, ACTOR, { cfg, db });
  assert.match(filename, /^prooftrail-.+\.zip$/);
  assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK', 'is a zip');

  const zip = new AdmZip(bytes);
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes('proof.json'), 'proof.json present');
  assert.ok(names.includes('report.pdf'), 'report.pdf present');
  assert.ok(names.includes('README.txt'), 'README.txt present');
  assert.ok(names.includes('originals/contract.pdf'), 'original present');

  const pdf = zip.readFile('report.pdf');
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', 'report.pdf is a PDF');
  const readme = zip.readFile('README.txt').toString('utf8');
  assert.match(readme, /ProofTrail/, 'README identifies ProofTrail');
  assert.ok(readme.length > 100, 'README has real content');
});

test('proof.json matches the contract and the original is byte-identical', async () => {
  const { bytes } = await downloadPackage(pkg.id, ACTOR, { cfg, db });
  const zip = new AdmZip(bytes);
  const proof = JSON.parse(zip.readFile('proof.json').toString('utf8'));

  assert.ok(proof.package, 'package block');
  assert.equal(proof.package.caseId, caseRec.id);
  assert.ok(proof.package.generatedAt.endsWith('Z'));
  assert.ok(proof.verificationUrl, 'verificationUrl included');
  assert.equal(proof.items.length, 1);

  const item = proof.items[0];
  assert.equal(item.evidence.id, evId);
  assert.equal(item.evidence.filename, 'contract.pdf');
  assert.equal(item.evidence.sha256, sha(BYTES));
  assert.ok(item.proof, 'per-item proof');
  assert.ok(item.proof.manifestHash);
  assert.ok(item.proof.ledger.seq.length === 12, 'ledger seq is 12-char padded');
  assert.equal(item.checksTotal, 6);
  assert.equal(item.checksPassed, 6, 'all six public checks pass on a fresh seal');
  for (const ch of item.checks) {
    assert.equal(typeof ch.name, 'string');
    assert.equal(typeof ch.passed, 'boolean');
    assert.equal(typeof ch.detail, 'string');
    assert.ok(ch.passed, `${ch.name} should pass: ${ch.detail}`);
  }
  assert.ok(item.publicKey, 'publicKey exported for offline verification');
  assert.equal(item.publicKey.algorithm, 'ECDSA_SHA_256');
  assert.equal(item.publicKey.keyId, item.proof.signature.keyId);
  assert.match(item.publicKey.publicKeyPem, /BEGIN PUBLIC KEY/);

  const orig = zip.readFile('originals/contract.pdf');
  assert.ok(orig.equals(BYTES), 'original byte-identical');
  const ev = await getEvidenceOwned(evId, ACTOR, cfg, db);
  assert.equal(ev.sha256, sha(BYTES), 'sealed hash matches the original');
});

test('report.pdf parses (header + page objects) and GET /packages/{id} round-trips', async () => {
  const { bytes } = await downloadPackage(pkg.id, ACTOR, { cfg, db });
  const pdf = new AdmZip(bytes).readFile('report.pdf').toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.'), 'header');
  assert.match(pdf, /\/Type\s*\/Page/, 'has a page object');

  const fetched = await getPackageOwned(pkg.id, ACTOR, { cfg, db });
  assert.deepEqual(shapePackage(fetched, cfg), pkg);
  const list = await listPackages(ACTOR, { caseId: caseRec.id }, { cfg, db });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, pkg.id);
});

test('the archive exists on disk under DATA_DIR/vault and matches the recorded size', async () => {
  const stored = path.join(cfg.dataDir, 'vault', 'packages', `${pkg.id}.zip`);
  assert.ok(fs.existsSync(stored), 'zip written to the local vault');
  const stat = fs.statSync(stored);
  assert.equal(stat.size, pkg.size, 'recorded size matches the bytes on disk');
});

test('another actor cannot fetch the package', async () => {
  const OTHER = { sub: 'usr_stranger', email: 'x@example.com', name: 'X' };
  await assert.rejects(
    () => getPackageOwned(pkg.id, OTHER, { cfg, db }),
    (e) => e.code === 'not_found',
  );
});
