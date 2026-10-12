// The seal pipeline (docs/API.md "Manifest" + ARCHITECTURE.md flow 3-7).
//
// read staging bytes -> recompute sha256 vs clientSha256 (mismatch -> status
// failed + 422 hash_mismatch on the request path) -> build canonical manifest ->
// TSA timestamp over the canonical manifest bytes -> sign canonical manifest ->
// append ledger entry -> write original to vault (write-once) -> update the
// evidence record with proof + status sealed.
//
// Timestamp rule (see docs/API.md): a timestamp token cannot cover itself, so
// the TSA timestamps the canonical manifest WITHOUT its `timestamp` field;
// the final manifest (including the token) is what gets signed and hashed into
// the ledger.

import { loadConfig, activeKeyId } from '../config.js';
import { AppError } from '../errors.js';
import { getDb } from './db.js';
import { canonicalBytes } from '../crypto/canonical.js';
import { sha256Hex } from '../crypto/hash.js';
import { signBytes } from '../crypto/keys.js';
import { createTimestamp } from './timestamp.js';
import * as ledger from './ledger.js';
import { appendAudit } from './audit.js';
import { getStagingBytes, getVaultBytes, sealMove, stagingKeyFor, vaultKeyFor, vaultExists } from './vault.js';

/** The fixed manifest field set from API.md, minus `timestamp`. */
export function buildManifestBase(ev, bytes, cfg) {
  const cap = ev.capture || {};
  return {
    capture: {
      appVersion: cap.appVersion ?? null,
      clientTime: cap.clientTime ?? null,
      device: cap.device ?? null,
      gps: cap.gps ?? null,
      serverTime: cap.serverTime ?? ev.createdAt ?? null,
      url: cap.url ?? null,
    },
    captureMethod: ev.captureMethod,
    evidenceId: ev.id,
    filename: ev.filename,
    serverTime: new Date().toISOString(),
    sha256: sha256Hex(bytes),
    size: bytes.length,
    type: ev.type,
    version: '1.0',
  };
}

/** Bytes the TSA timestamps: the canonical manifest without `timestamp`. */
export function timestampedBytes(manifestBase) {
  return canonicalBytes(manifestBase);
}

/**
 * Verify the staged bytes against the client hash WITHOUT sealing.
 * Sets status failed + 422 on mismatch (API.md upload contract).
 * @returns {Buffer} the verified bytes
 */
export async function verifyStagedHash(evidenceId, cfg = loadConfig(), db = getDb(cfg)) {
  const ev = await db.getEvidence(evidenceId);
  if (!ev || ev.deletedAt) throw new AppError('not_found', 'Evidence not found');
  let bytes;
  try {
    bytes = await getStagingBytes(stagingKeyFor(ev.id), cfg);
  } catch (e) {
    if (e instanceof AppError && e.code === 'not_found') {
      throw new AppError('conflict', 'No staged upload found — upload the file first');
    }
    throw e;
  }
  if (bytes.length > cfg.maxEvidenceSize) {
    await db.updateEvidence(ev.id, { status: 'failed', sealError: 'payload_too_large: upload exceeds MAX_EVIDENCE_SIZE', updatedAt: new Date().toISOString() });
    throw new AppError('payload_too_large', 'Uploaded file exceeds MAX_EVIDENCE_SIZE');
  }
  const actual = sha256Hex(bytes);
  if (actual !== ev.clientSha256) {
    await db.updateEvidence(ev.id, {
      status: 'failed',
      hashMatched: false,
      sealError: `hash_mismatch: server sha256 ${actual} != clientSha256 ${ev.clientSha256}`,
      updatedAt: new Date().toISOString(),
    });
    throw new AppError('hash_mismatch', 'Uploaded bytes do not match the client-provided SHA-256');
  }
  return bytes;
}

/**
 * Run the full seal pipeline for one evidence item.
 * Idempotent when already sealed. Failures set status failed + sealError.
 * @returns {object} the updated evidence record
 */
export async function runSeal(evidenceId, cfg = loadConfig(), db = getDb(cfg), opts = {}) {
  const original = await db.getEvidence(evidenceId);
  if (!original || original.deletedAt) throw new AppError('not_found', 'Evidence not found');
  if (original.status === 'sealed' && original.proof) return original; // idempotent
  if (original.status === 'pending_upload') {
    throw new AppError('conflict', 'No staged upload found — upload the file first');
  }

  const now = () => new Date().toISOString();
  await db.updateEvidence(evidenceId, { status: 'sealing', sealError: null, updatedAt: now() });

  try {
    // 1. verified bytes (re-checks the hash; throws 422 + failed on mismatch)
    const bytes = await verifyStagedHash(evidenceId, cfg, db);
    const ev = await db.getEvidence(evidenceId);

    // 2. canonical manifest (no timestamp yet) -> TSA timestamp
    const base = buildManifestBase(ev, bytes, cfg);
    const ts = await createTimestamp(timestampedBytes(base), cfg);

    // 3. final manifest incl. timestamp -> manifestHash -> sign
    const manifest = {
      ...base,
      timestamp: { genTime: ts.genTime, mode: ts.mode, token: ts.token, tsa: ts.tsa },
    };
    const canonical = canonicalBytes(manifest);
    const manifestHash = sha256Hex(canonical);
    const signature = await signBytes(canonical, cfg, activeKeyId(cfg));

    // 4. append-only ledger entry
    const entry = await ledger.append({ evidenceId: ev.id, manifestHash }, cfg, db);

    // 5. write the original to the vault, write-once
    const storageKey = ev.storageKey || vaultKeyFor(ev.id, ev.filename, new Date(ev.createdAt));
    if (!(await vaultExists(storageKey, cfg))) {
      await sealMove(stagingKeyFor(ev.id), storageKey, cfg);
    }

    // 6. update the evidence record
    const sealedAt = now();
    const proof = {
      manifest,
      manifestHash,
      signature,
      timestamp: { mode: ts.mode, tsa: ts.tsa, token: ts.token, genTime: ts.genTime },
      ledger: { seq: entry.seq, prevHash: entry.prevHash, entryHash: entry.entryHash },
      anchor: ev.proof?.anchor ?? null,
      sealedAt,
    };
    const updated = await db.updateEvidence(ev.id, {
      status: 'sealed',
      sealError: null,
      sha256: base.sha256,
      hashMatched: true,
      size: base.size,
      storageKey,
      proof,
      updatedAt: sealedAt,
    });
    // custody log: sealing is a required audit action (API.md action enum)
    try {
      await appendAudit(
        { evidenceId: ev.id, actor: opts.actor || 'system', action: 'seal', ip: opts.ip || 'internal' },
        cfg,
        db
      );
    } catch (e) {
      console.error(`[seal] audit append failed for ${ev.id}: ${e.message}`);
    }
    return updated;
  } catch (err) {
    const message = err instanceof AppError
      ? `${err.code}: ${err.message}`
      : `seal_failed: ${err && err.message ? err.message : String(err)}`;
    try {
      await db.updateEvidence(evidenceId, { status: 'failed', sealError: message, updatedAt: now() });
    } catch (e) {
      console.error(`[seal] failed to record failure for ${evidenceId}: ${e.message}`);
    }
    throw err;
  }
}

/** Raw bytes for a (sealed) evidence item — vault first, staging fallback. */
export async function evidenceBytes(ev, cfg = loadConfig()) {
  if (ev.storageKey && (await vaultExists(ev.storageKey, cfg))) {
    return getVaultBytes(ev.storageKey, cfg);
  }
  try {
    return await getStagingBytes(stagingKeyFor(ev.id), cfg);
  } catch {
    throw new AppError('not_found', 'No stored bytes for this evidence item');
  }
}
