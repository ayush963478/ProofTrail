// Public verification computation (docs/API.md GET /public/verify/{token}).
//
// The six checks, computed server-side. Shared by the public handler and the
// package generator (proof.json embeds the same checks).

import { loadConfig } from '../config.js';
import { getDb } from './db.js';
import { canonicalBytes } from '../crypto/canonical.js';
import { sha256Hex, isSha256Hex } from '../crypto/hash.js';
import { verifyBytes } from '../crypto/signature.js';
import { getPublicKey } from '../crypto/keys.js';
import { verifyTimestamp } from './timestamp.js';
import * as ledger from './ledger.js';
import { anchorCheck } from './anchor.js';

const check = (name, passed, detail) => ({ name, passed: !!passed, detail });

/** The canonical manifest bytes minus `timestamp` (what the TSA timestamped). */
export function timestampedManifestBytes(manifest) {
  const { timestamp, ...rest } = manifest || {};
  void timestamp;
  return canonicalBytes(rest);
}

/** Public evidence subset for the verify page. */
export function publicEvidenceView(ev) {
  const cap = ev.capture || {};
  return {
    id: ev.id,
    type: ev.type,
    filename: ev.filename,
    size: ev.size,
    sha256: ev.sha256,
    captureMethod: ev.captureMethod,
    capture: {
      device: cap.device ?? null,
      appVersion: cap.appVersion ?? null,
      url: cap.url ?? null,
      gps: cap.gps ?? null,
      clientTime: cap.clientTime ?? null,
      serverTime: cap.serverTime ?? null,
    },
    sealedAt: ev.proof?.sealedAt ?? null,
  };
}

/**
 * Build { proof, checks, checksPassed, checksTotal } for one evidence item.
 * proof is null when the item has never been sealed (checks then fail with
 * explanatory details rather than the page erroring out).
 */
export async function evidenceChecks(ev, { deep = false } = {}, cfg = loadConfig(), db = getDb(cfg)) {
  const checks = [];
  const proof = ev.proof || null;

  // 1. hash_present
  checks.push(check('hash_present', isSha256Hex(ev.sha256),
    isSha256Hex(ev.sha256)
      ? `sha256 ${ev.sha256.slice(0, 16)}… present`
      : 'no server-computed SHA-256 recorded'));

  if (!proof) {
    checks.push(check('manifest_integrity', false, 'evidence has not been sealed — no manifest'));
    checks.push(check('signature', false, 'evidence has not been sealed — no signature'));
    checks.push(check('timestamp', false, 'evidence has not been sealed — no timestamp token'));
    checks.push(check('ledger_chain', false, 'evidence has not been sealed — no ledger entry'));
    checks.push(check('anchor', false, 'evidence has not been sealed — nothing anchored'));
    const passed = checks.filter((c) => c.passed).length;
    return { proof: null, checks, checksPassed: passed, checksTotal: checks.length };
  }

  const canonical = canonicalBytes(proof.manifest);

  // 2. manifest_integrity — sha256(canonical manifest) == manifestHash
  const recomputed = sha256Hex(canonical);
  checks.push(check('manifest_integrity', recomputed === proof.manifestHash,
    recomputed === proof.manifestHash
      ? `manifestHash matches canonical manifest (${proof.manifestHash.slice(0, 16)}…)`
      : `manifestHash mismatch: recorded ${proof.manifestHash}, recomputed ${recomputed}`));

  // 3. signature — verify value over canonical bytes with the public key
  let signatureView = { ...proof.signature, publicKeyPem: null, source: null };
  let sigOk = false;
  let sigDetail;
  try {
    const key = await getPublicKey(proof.signature.keyId, cfg);
    signatureView = { ...proof.signature, publicKeyPem: key.publicKeyPem, source: key.source };
    sigOk = verifyBytes(canonical, proof.signature.value, key.publicKeyPem);
    sigDetail = sigOk
      ? `ECDSA P-256 signature verifies with key ${proof.signature.keyId} (${key.source})`
      : `signature verification failed for key ${proof.signature.keyId}`;
  } catch (e) {
    sigDetail = `public key ${proof.signature.keyId} unavailable: ${e.message}`;
  }
  checks.push(check('signature', sigOk, sigDetail));

  // 4. timestamp — imprint matches the timestamped manifest bytes, genTime, TSA signature
  let tsOk = false;
  let tsDetail;
  try {
    const v = verifyTimestamp(proof.timestamp, {
      expectedHash: sha256Hex(timestampedManifestBytes(proof.manifest)),
    });
    tsOk = true;
    tsDetail = v.detail;
  } catch (e) {
    tsDetail = e.message;
  }
  const timestampView = { ...proof.timestamp, verified: tsOk };

  // 5. ledger_chain — recompute entryHash + previous link (?deep=1 -> genesis)
  const entry = await ledger.get(proof.ledger.seq, cfg, db);
  let ledgerOk = false;
  let ledgerDetail;
  if (!entry) {
    ledgerDetail = `ledger entry ${proof.ledger.seq} not found`;
  } else if (entry.manifestHash !== proof.manifestHash) {
    ledgerDetail = `ledger manifestHash (${entry.manifestHash.slice(0, 16)}…) does not match proof.manifestHash`;
  } else {
    const r = await ledger.checkEntry(entry, { deep }, cfg, db);
    ledgerOk = r.passed;
    ledgerDetail = r.detail;
  }
  const ledgerView = {
    seq: proof.ledger.seq,
    prevHash: proof.ledger.prevHash,
    entryHash: proof.ledger.entryHash,
    chainVerified: ledgerOk,
    deepChecked: !!deep,
  };

  // 6. anchor — merkle inclusion, or "pending batch" (counts as pass)
  let anchorView = null;
  let anchorPassed = false;
  let anchorDetail;
  if (entry) {
    const a = await anchorCheck(entry, cfg, db);
    anchorPassed = a.passed;
    anchorDetail = a.detail;
    anchorView = a.value ? { ...a.value, included: a.value.included !== false } : null;
  } else {
    anchorDetail = 'no ledger entry to anchor';
  }

  checks.push(check('timestamp', tsOk, tsDetail));
  checks.push(check('ledger_chain', ledgerOk, ledgerDetail));
  checks.push(check('anchor', anchorPassed, anchorDetail));

  const passed = checks.filter((c) => c.passed).length;
  return {
    proof: {
      manifest: proof.manifest,
      manifestHash: proof.manifestHash,
      signature: signatureView,
      timestamp: timestampView,
      ledger: ledgerView,
      anchor: anchorView,
    },
    checks,
    checksPassed: passed,
    checksTotal: checks.length,
  };
}

/** Aggregate all-item check for package scope. */
export function aggregateChecks(items) {
  const totals = new Map();
  for (const item of items) {
    for (const c of item.checks) {
      const cur = totals.get(c.name) || { name: c.name, passed: true, detail: [] };
      cur.passed = cur.passed && c.passed;
      cur.detail.push(`${item.evidence.filename}: ${c.detail}`);
      totals.set(c.name, cur);
    }
  }
  const checks = [...totals.values()].map((c) => ({
    name: c.name,
    passed: c.passed,
    detail: c.detail.length <= 2 ? c.detail.join('; ') : `${c.detail.slice(0, 2).join('; ')}; +${c.detail.length - 2} more items`,
  }));
  return { checks, checksPassed: checks.filter((c) => c.passed).length, checksTotal: checks.length };
}
