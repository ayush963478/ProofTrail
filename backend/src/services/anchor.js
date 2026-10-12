// Periodic Merkle anchoring (docs/DATA-MODEL.md ANCHOR table).
//
// anchorNow(): take all ledger entries since the last batch (cap 500) ->
// leaves = entryHash -> Merkle root -> write ROOT#<root> + BATCH#<batchId> ->
// publish externally (POST ANCHOR_EXTERNAL_URL when set) and always append to
// backend/.data/anchors/publish-log.jsonl in local mode so the operator itself
// cannot rewrite batches silently.
//
// Used by the anchorScheduler handler (EventBridge rate(15 minutes) in aws,
// timer + `npm run anchor` in local mode).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { getDb } from './db.js';
import { merkleRoot, merkleProof, verifyMerkleProof } from '../crypto/merkle.js';
import { padSeq, seqNumber } from './ledger.js';

/** Append one line to the external publish log (local mode / operator audit). */
export function appendPublishLog(record, cfg = loadConfig()) {
  fs.mkdirSync(cfg.anchorsDir, { recursive: true });
  const file = path.join(cfg.anchorsDir, 'publish-log.jsonl');
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/**
 * Build and publish one batch from entries after the last batch.
 * @returns {{skipped?: true, reason?: string} | {root, batchId, fromSeq, toSeq, leafCount, publishedAt, externalRef, logPath?}}
 */
export async function anchorNow(cfg = loadConfig(), db = getDb(cfg)) {
  const last = await db.latestAnchorBatch();
  const lastTo = last ? seqNumber(last.toSeq) : 0;
  const entries = (await db.ledgerAll()).filter((e) => seqNumber(e.seq) > lastTo);
  if (entries.length === 0) {
    return { skipped: true, reason: 'no new ledger entries' };
  }
  const batch = entries.slice(0, cfg.anchorBatchCap);
  const leaves = batch.map((e) => e.entryHash);
  const root = merkleRoot(leaves);
  const fromSeq = batch[0].seq;
  const toSeq = batch[batch.length - 1].seq;
  const batchId = `anch_${crypto.randomBytes(8).toString('hex')}`;
  const publishedAt = new Date().toISOString();

  let externalRef = null;
  let externalError = null;
  if (cfg.anchorExternalUrl) {
    try {
      const res = await fetch(cfg.anchorExternalUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root, batchId, fromSeq, toSeq, leafCount: batch.length, publishedAt }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const text = (await res.text()).slice(0, 2000);
        externalRef = text || `${cfg.anchorExternalUrl}#${batchId}`;
      } else {
        externalError = `anchor external publish responded ${res.status}`;
      }
    } catch (e) {
      externalError = `anchor external publish failed: ${e.message}`;
    }
    if (externalError) console.warn(`[anchor] ${externalError} (root still recorded + logged)`);
  }

  const rootItem = {
    PK: `ROOT#${root}`,
    root,
    batchId,
    fromSeq,
    toSeq,
    leafCount: batch.length,
    publishedAt,
    externalRef,
    entries: batch.map((e) => ({ seq: e.seq, entryHash: e.entryHash })),
  };
  try {
    await db.putAnchorBatch(rootItem);
  } catch (e) {
    if (e instanceof AppError && e.code === 'conflict') {
      return { skipped: true, reason: 'batch root already anchored' };
    }
    throw e;
  }

  const record = {
    root,
    batchId,
    fromSeq,
    toSeq,
    leafCount: batch.length,
    publishedAt,
    externalRef,
    externalUrl: cfg.anchorExternalUrl || null,
    externalError,
  };
  let logPath = null;
  if (cfg.mode === 'local' || !cfg.anchorExternalUrl) {
    // Always keep an operator-independent publish log in local mode.
    if (cfg.mode === 'local') {
      appendPublishLog(record, cfg);
      logPath = path.join(cfg.anchorsDir, 'publish-log.jsonl');
    }
  }

  // Fill proof.anchor on the affected evidence records (additive; ledger rows
  // and proofs otherwise stay immutable). Best-effort.
  try {
    for (const e of batch) {
      const ev = await db.getEvidence(e.evidenceId);
      if (!ev || !ev.proof || ev.proof.anchor) continue;
      const idx = seqNumber(e.seq) - seqNumber(fromSeq);
      const { siblings } = merkleProof(leaves, idx);
      await db.updateEvidence(ev.id, {
        proof: {
          ...ev.proof,
          anchor: {
            root,
            batchId,
            fromSeq,
            toSeq,
            publishedAt,
            externalRef,
            merkleProof: siblings,
          },
        },
      });
    }
  } catch (e) {
    console.warn(`[anchor] failed to backfill evidence anchors: ${e.message}`);
  }

  return { root, batchId, fromSeq, toSeq, leafCount: batch.length, publishedAt, externalRef, logPath };
}

/**
 * Resolve the anchor inclusion for a ledger seq.
 * @returns {null} when no published batch covers the seq (pending),
 *          otherwise {root, batchId, fromSeq, toSeq, publishedAt, externalRef,
 *                     leafCount, merkleProof, included}
 */
export async function resolveAnchorForSeq(seq, cfg = loadConfig(), db = getDb(cfg)) {
  const batches = await db.listAnchorBatches();
  const n = seqNumber(seq);
  const hit = batches.find((b) => seqNumber(b.fromSeq) <= n && n <= seqNumber(b.toSeq));
  if (!hit) return null;
  const rootItem = await db.getAnchorByRoot(hit.root);
  if (!rootItem) return null;
  const leaves = (rootItem.entries || []).map((e) => e.entryHash);
  const idx = n - seqNumber(rootItem.fromSeq);
  if (idx < 0 || idx >= leaves.length) return null;
  const { siblings } = merkleProof(leaves, idx);
  const recomputed = verifyMerkleProof(leaves[idx], siblings, idx, leaves.length);
  return {
    root: rootItem.root,
    batchId: rootItem.batchId,
    fromSeq: rootItem.fromSeq,
    toSeq: rootItem.toSeq,
    leafCount: rootItem.leafCount,
    publishedAt: rootItem.publishedAt,
    externalRef: rootItem.externalRef ?? null,
    merkleProof: siblings,
    included: recomputed === rootItem.root,
  };
}

/** The anchor check for GET /public/verify/{token}. Always passes (pending counts as pass). */
export async function anchorCheck(entry, cfg = loadConfig(), db = getDb(cfg)) {
  if (!entry) {
    return { passed: false, detail: 'no ledger entry to anchor', value: null };
  }
  const anchor = await resolveAnchorForSeq(entry.seq, cfg, db);
  if (!anchor) {
    return {
      passed: true,
      detail: 'pending batch — anchored periodically',
      value: null,
    };
  }
  return {
    passed: !!anchor.included,
    detail: anchor.included
      ? `included in root ${anchor.root.slice(0, 16)}… (batch ${anchor.batchId})`
      : `merkle proof does not match root ${anchor.root}`,
    value: anchor,
  };
}
