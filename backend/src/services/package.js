// Evidence package generation (docs/API.md Packages routes).
//
// ZIP: originals/<filename> + report.pdf (pdfkit: title, case, per-item
// hash/timestamp/signature/ledger/forensics summary, legal disclaimer from
// blueprint §8) + proof.json (manifests, proofs, checks, public key) +
// verification QR (in the report + README) + README.txt.
// Synchronous generation; creates a package-scoped Share -> verificationUrl.

import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { getDb } from './db.js';
import { evidenceBytes } from './seal.js';
import { putVaultBytesOnce, getVaultBytes, vaultExists } from './vault.js';
import { createShare, verificationUrl } from './share.js';
import { evidenceChecks, aggregateChecks, publicEvidenceView } from './verify.js';
import { getPublicKey } from '../crypto/keys.js';
import { analyze } from './forensics.js';

const nowIso = () => new Date().toISOString();

/** API.md Package shape (extra fields stay in the DB). */
export function shapePackage(pkg, cfg = loadConfig()) {
  return {
    id: pkg.id,
    caseId: pkg.caseId,
    evidenceIds: pkg.evidenceIds,
    itemCount: pkg.itemCount,
    size: pkg.size,
    generatedAt: pkg.generatedAt,
    verificationUrl: pkg.verificationUrl,
    shareToken: pkg.shareToken,
    downloadUrl: `${cfg.apiBaseUrl}/packages/${pkg.id}/download`,
  };
}

export async function listPackages(actor, { caseId } = {}, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const db = opts.db || getDb(cfg);
  let items = await db.listPackages(actor.sub);
  if (caseId) items = items.filter((p) => p.caseId === caseId);
  return items.map((p) => shapePackage(p, cfg));
}

export async function getPackageOwned(id, actor, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const db = opts.db || getDb(cfg);
  const pkg = await db.getPackage(id);
  if (!pkg || pkg.ownerId !== actor.sub) throw new AppError('not_found', 'Package not found');
  return pkg;
}

export async function downloadPackage(id, actor, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const pkg = await getPackageOwned(id, actor, opts);
  const key = `packages/${pkg.id}.zip`;
  if (!(await vaultExists(key, cfg))) throw new AppError('not_found', 'Package archive not found');
  const bytes = await getVaultBytes(key, cfg);
  return { bytes, filename: `prooftrail-${pkg.id}.zip` };
}

// ---------------------------------------------------------------------------
// PDF report
// ---------------------------------------------------------------------------

async function renderPdf({ pkg, items, caseInfo, verificationUrl: vurl }) {
  const PDFDocument = (await import('pdfkit')).default;
  const QRCode = (await import('qrcode')).default;
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });

  doc.fontSize(20).text('ProofTrail Evidence Package', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#555')
    .text(`Package ${pkg.id} · generated ${pkg.generatedAt} · ${pkg.itemCount} item(s)`, { align: 'center' });
  doc.moveDown(0.5);

  if (caseInfo) {
    doc.fillColor('#000').fontSize(13).text('Case');
    doc.fontSize(10).fillColor('#333')
      .text(`${caseInfo.title}${caseInfo.description ? ` — ${caseInfo.description}` : ''}`)
      .text(`Case ID: ${caseInfo.id}`);
    doc.moveDown(0.5);
  }

  // verification QR
  try {
    const qr = await QRCode.toBuffer(vurl, { type: 'png', width: 160, margin: 1 });
    doc.image(qr, { width: 110, align: 'center' });
    doc.fontSize(9).fillColor('#333').text(`Scan or open to verify: ${vurl}`, { align: 'center' });
  } catch {
    doc.fontSize(9).fillColor('#333').text(`Verify at: ${vurl}`, { align: 'center' });
  }
  doc.moveDown();

  for (const item of items) {
    const { evidence: ev, proof, checks, forensic } = item;
    doc.addPage();
    doc.fillColor('#000').fontSize(14).text(ev.filename);
    doc.fontSize(9).fillColor('#555').text(`${ev.id} · ${ev.type} · ${ev.mimeType || ''} ${ev.size} bytes`);
    doc.moveDown(0.4);

    doc.fillColor('#000').fontSize(11).text('Integrity');
    doc.fontSize(9).fillColor('#333');
    doc.text(`SHA-256 (server): ${ev.sha256}`);
    doc.text(`Capture method: ${ev.captureMethod}`);
    if (ev.capture?.url) doc.text(`Source URL: ${ev.capture.url}`);
    if (ev.capture?.clientTime) doc.text(`Client time: ${ev.capture.clientTime}`);
    doc.text(`Server time: ${ev.capture?.serverTime || '-'}`);
    if (ev.capture?.device) doc.text(`Device: ${ev.capture.device}`);

    if (proof) {
      doc.moveDown(0.3);
      doc.fillColor('#000').fontSize(11).text('Cryptographic proof');
      doc.fontSize(9).fillColor('#333');
      doc.text(`Sealed at: ${proof.sealedAt}`);
      doc.text(`Manifest SHA-256: ${proof.manifestHash}`);
      doc.text(`Timestamp: ${proof.timestamp.mode}${proof.timestamp.tsa ? ` (${proof.timestamp.tsa})` : ' — dev/local flag'} · genTime ${proof.timestamp.genTime}`);
      doc.text(`Signature: ${proof.signature.algorithm} by key ${proof.signature.keyId}`);
      doc.text(`Ledger: seq ${proof.ledger.seq} · prev ${proof.ledger.prevHash.slice(0, 24)}… · entry ${proof.ledger.entryHash.slice(0, 24)}…`);
      if (proof.anchor?.root) doc.text(`Anchor: root ${proof.anchor.root.slice(0, 32)}… batch ${proof.anchor.batchId}`);
      else doc.text('Anchor: pending batch (anchored periodically)');
    }

    if (checks?.length) {
      doc.moveDown(0.3);
      doc.fillColor('#000').fontSize(11).text('Verification checks');
      doc.fontSize(9).fillColor('#333');
      for (const c of checks) doc.text(`• ${c.name}: ${c.passed ? 'PASS' : 'FAIL'} — ${c.detail}`);
      doc.text(`Score: ${item.checksPassed}/${item.checksTotal}`);
    }

    if (forensic?.indicators?.length) {
      doc.moveDown(0.3);
      doc.fillColor('#000').fontSize(11).text('Forensic indicators (heuristics — not a verdict)');
      doc.fontSize(9).fillColor('#333');
      for (const i of forensic.indicators) {
        doc.text(`• ${i.name}: ${i.status.toUpperCase()} (${i.confidence.toFixed(2)}) — ${i.detail}`);
      }
    }
  }

  doc.addPage();
  doc.fillColor('#000').fontSize(13).text('Legal notes and known limits');
  doc.fontSize(9).fillColor('#333');
  doc.text(
    'ProofTrail strengthens the technical credibility of evidence, but it does not decide admissibility. ' +
    'Rules differ by country and court. Before relying on this package, obtain advice from a qualified lawyer ' +
    'in your jurisdiction, and describe the method as supporting authenticity, not guaranteeing acceptance.',
    { align: 'justify' },
  );
  doc.moveDown(0.4);
  doc.text(
    'Known limits: a capture proves what was on the screen or page at capture time, not that the underlying ' +
    'claim is true; a determined user could still stage content before capturing it. This package contains the ' +
    'original bytes, a machine-checkable proof.json and this report so that any recipient can independently ' +
    'recompute the hashes, verify the ECDSA signature, validate the RFC 3161 timestamp token and walk the ' +
    'hash-chained ledger.',
    { align: 'justify' },
  );
  doc.moveDown(0.4);
  doc.text(`Verification link: ${vurl}`);
  doc.text(`Package proof hash: sha256 of proof.json is recomputable by any recipient.`);

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

function buildReadme({ pkg, vurl }) {
  return [
    'ProofTrail Evidence Package',
    '===========================',
    '',
    `Package ID : ${pkg.id}`,
    `Generated  : ${pkg.generatedAt}`,
    `Items      : ${pkg.itemCount}`,
    `Verify here: ${vurl}`,
    '',
    'Contents',
    '--------',
    'originals/     the original evidence files, byte-for-byte as stored in the vault',
    'report.pdf     human-readable report: hashes, timestamps, signatures, ledger entries,',
    '               forensic indicators and the legal disclaimer',
    'proof.json     machine-checkable proof: canonical manifests, manifest hashes,',
    '               signatures, timestamp tokens, ledger entries and verification checks',
    'README.txt     this file',
    '',
    'How to verify',
    '-------------',
    '1. Open the verification link above (or scan the QR in report.pdf) — the public',
    '   portal recomputes every check server-side and shows your browser-side results.',
    '2. Recompute SHA-256 of an original file and compare with proof.json.',
    '3. Recompute canonicalJson(manifest) -> SHA-256 and compare with manifestHash.',
    '4. Verify signature.value (base64 DER ECDSA P-256/SHA-256) with the public key',
    '   from GET /public/keys/{keyId} using WebCrypto (DER -> raw r||s, 64 bytes).',
    '',
    'Legal note',
    '----------',
    'ProofTrail supports authenticity; it does not guarantee acceptance in court.',
    'A capture proves what was visible at capture time, not that the underlying claim',
    'is true. See report.pdf for the full disclaimer.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// create / get
// ---------------------------------------------------------------------------

/** POST /packages — synchronous generation. */
export async function createPackage(actor, body, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const db = opts.db || getDb(cfg);
  if (!body || !body.caseId) throw new AppError('validation_error', 'caseId is required');
  const caseInfo = await db.getCase(String(body.caseId));
  if (!caseInfo || caseInfo.deletedAt || caseInfo.ownerId !== actor.sub) {
    throw new AppError('not_found', 'Case not found');
  }

  const all = (await db.listEvidence(actor.sub)).filter((e) => e.caseId === caseInfo.id);
  let selected;
  if (Array.isArray(body.evidenceIds) && body.evidenceIds.length > 0) {
    selected = [];
    for (const id of body.evidenceIds) {
      const ev = all.find((e) => e.id === id);
      if (!ev) throw new AppError('not_found', `Evidence ${id} not found in this case`);
      selected.push(ev);
    }
  } else {
    selected = all;
  }
  const sealed = selected.filter((e) => e.status === 'sealed' && e.proof);
  if (selected.length === 0) throw new AppError('validation_error', 'case has no evidence items');
  if (sealed.length !== selected.length) {
    const bad = selected.filter((e) => e.status !== 'sealed').map((e) => `${e.id} (${e.status})`);
    throw new AppError('conflict', `only sealed evidence can be packaged; not sealed: ${bad.join(', ')}`);
  }

  const generatedAt = nowIso();
  const pkgId = `pkg_${crypto.randomBytes(8).toString('hex')}`;

  // per-item proof + checks + forensics summary
  const items = [];
  for (const ev of sealed) {
    const { proof, checks, checksPassed, checksTotal } = await evidenceChecks(ev, { deep: false }, cfg, db);
    let publicKey = null;
    if (ev.proof?.signature?.keyId) {
      try { publicKey = await getPublicKey(ev.proof.signature.keyId, cfg); } catch { publicKey = null; }
    }
    const forensic = ev.forensicReport || {
      evidenceId: ev.id,
      modelVersion: 'heuristics-1.0.0',
      generatedAt: null,
      indicators: analyze({
        bytes: await evidenceBytes(ev, cfg),
        filename: ev.filename,
        mimeType: ev.mimeType,
        capture: ev.capture,
        type: ev.type,
      }),
    };
    items.push({
      evidence: { ...publicEvidenceView(ev), mimeType: ev.mimeType },
      proof,
      checks,
      checksPassed,
      checksTotal,
      publicKey,
      forensic,
    });
  }

  const share = await createShare(
    { scope: 'package', targetId: pkgId, includeDownload: true },
    cfg,
    db,
  );
  const vurl = verificationUrl(share.token, cfg);

  const proofJson = {
    package: { id: pkgId, caseId: caseInfo.id, generatedAt, itemCount: items.length },
    verificationUrl: vurl,
    items: items.map(({ evidence, proof, checks, checksPassed, checksTotal, publicKey }) => ({
      evidence,
      proof,
      checks,
      checksPassed,
      checksTotal,
      publicKey,
    })),
  };
  const aggregate = aggregateChecks(items);

  // --- originals/ (dedupe names) ---
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip();
  const used = new Map();
  for (const ev of sealed) {
    let name = ev.filename;
    const n = used.get(name) || 0;
    used.set(name, n + 1);
    if (n > 0) {
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    }
    zip.addFile(`originals/${name}`, await evidenceBytes(ev, cfg));
  }

  const pdf = await renderPdf({ pkg: { id: pkgId, generatedAt, itemCount: items.length }, items, caseInfo, verificationUrl: vurl });
  zip.addFile('report.pdf', pdf);
  zip.addFile('proof.json', Buffer.from(JSON.stringify(proofJson, null, 2), 'utf8'));
  zip.addFile('README.txt', Buffer.from(buildReadme({ pkg: { id: pkgId, generatedAt, itemCount: items.length }, vurl }), 'utf8'));
  const zipBuf = zip.toBuffer();

  const key = `packages/${pkgId}.zip`;
  if (await vaultExists(key, cfg)) {
    throw new AppError('conflict', `package ${pkgId} already exists`);
  }
  await putVaultBytesOnce(key, zipBuf, cfg);

  const record = {
    id: pkgId,
    caseId: caseInfo.id,
    ownerId: actor.sub,
    evidenceIds: sealed.map((e) => e.id),
    itemCount: sealed.length,
    size: zipBuf.length,
    generatedAt,
    verificationUrl: vurl,
    shareToken: share.token,
    shareId: share.id,
    aggregate,
    createdAt: generatedAt,
  };
  await db.putPackage(record);
  return shapePackage(record, cfg);
}

/** Fetch a package by id (for public package-scope downloads). */
export async function getPackageById(id, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const db = opts.db || getDb(cfg);
  return db.getPackage(id);
}

/** Bytes for a package-scope share download. */
export async function packageBytesByToken(share, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const pkg = await getPackageById(share.targetId, opts);
  if (!pkg) throw new AppError('not_found', 'Package not found');
  const key = `packages/${pkg.id}.zip`;
  if (!(await vaultExists(key, cfg))) throw new AppError('not_found', 'Package archive not found');
  return { bytes: await getVaultBytes(key, cfg), filename: `prooftrail-${pkg.id}.zip`, pkg };
}
