// Append-only, hash-chained ledger (docs/DATA-MODEL.md LEDGER table).
//
// - seq: zero-padded 12-char string ("000000000042")
// - genesis prevHash = 64 zeros
// - entryHash = sha256(utf8(prevHash + "|" + manifestHash + "|" + seq))
// - append-only: conditional put (attribute_not_exists), never updated;
//   on condition failure re-read max seq and retry (single-writer retry loop)
// - chain verification: recompute entryHash + previous link, ?deep=1 walks to
//   genesis.

import { sha256Hex } from '../crypto/hash.js';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { getDb } from './db.js';

export const GENESIS_PREV_HASH = '0'.repeat(64);
export const SEQ_LEN = 12;

export function padSeq(n) {
  return String(n).padStart(SEQ_LEN, '0');
}

export function seqNumber(seq) {
  return Number.parseInt(String(seq), 10);
}

export function entryHashOf({ prevHash, manifestHash, seq }) {
  return sha256Hex(`${prevHash}|${manifestHash}|${seq}`);
}

/**
 * Append one ledger entry for a sealed manifest.
 * Retries a few times when the conditional put loses a race.
 */
export async function append({ evidenceId, manifestHash }, cfg = loadConfig(), db = getDb(cfg)) {
  if (!evidenceId || !manifestHash) throw new AppError('validation_error', 'evidenceId and manifestHash are required');
  const sealedAt = new Date().toISOString();
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    const latest = await db.ledgerLatest();
    const seq = padSeq(latest ? seqNumber(latest.seq) + 1 : 1);
    const prevHash = latest ? latest.entryHash : GENESIS_PREV_HASH;
    const entry = { seq, evidenceId, manifestHash, prevHash, entryHash: entryHashOf({ prevHash, manifestHash, seq }), sealedAt };
    try {
      return await db.ledgerAppend(entry);
    } catch (e) {
      if (e instanceof AppError && e.code === 'conflict') continue; // lost the race: retry
      throw e;
    }
  }
  throw new AppError('conflict', 'Ledger append contention — retry later');
}

export async function get(seq, cfg = loadConfig(), db = getDb(cfg)) {
  return db.ledgerGet(seq);
}

export async function latest(cfg = loadConfig(), db = getDb(cfg)) {
  return db.ledgerLatest();
}

export async function range(fromSeq, toSeq, cfg = loadConfig(), db = getDb(cfg)) {
  return db.ledgerRange(fromSeq, toSeq);
}

export async function all(cfg = loadConfig(), db = getDb(cfg)) {
  return db.ledgerAll();
}

/** Recompute entryHash for a single entry (returns bool). */
export function entryIntact(entry) {
  if (!entry || !entry.seq || !entry.manifestHash || !entry.prevHash) return false;
  return entryHashOf(entry) === entry.entryHash;
}

/**
 * Verify an entry against its predecessor.
 * @returns {{hashOk: boolean, linkOk: boolean}}
 */
export function checkLink(entry, prevEntry) {
  const hashOk = entryIntact(entry);
  let linkOk;
  if (seqNumber(entry.seq) === 1) {
    linkOk = entry.prevHash === GENESIS_PREV_HASH;
  } else if (prevEntry) {
    linkOk = prevEntry.entryHash === entry.prevHash && prevEntry.seq === padSeq(seqNumber(entry.seq) - 1);
  } else {
    linkOk = false;
  }
  return { hashOk, linkOk };
}

/**
 * Full chain verification.
 * @param {Array} entries sorted (or unsorted) ledger entries
 * @param {boolean} deep walk every entry to genesis (default: verify the
 *        supplied entries and their links, walking back to genesis anyway when
 *        the full chain is available)
 * @returns {{ok, checked, firstBadSeq, deepChecked}}
 */
export function verifyChain(entries, { deep = false } = {}) {
  if (!entries || entries.length === 0) return { ok: true, checked: 0, firstBadSeq: null, deepChecked: deep };
  const sorted = [...entries].sort((a, b) => (a.seq < b.seq ? -1 : 1));
  let prev = null;
  for (const e of sorted) {
    const { hashOk, linkOk } = checkLink(e, prev);
    if (!hashOk || !linkOk) {
      return { ok: false, checked: sorted.length, firstBadSeq: e.seq, deepChecked: deep };
    }
    prev = e;
  }
  return { ok: true, checked: sorted.length, firstBadSeq: null, deepChecked: deep };
}

/**
 * The ledger_chain check used by GET /public/verify/{token}.
 * Verifies one entry's hash + link to its predecessor; with deep=true walks
 * the entire chain back to genesis.
 *
 * @returns {{passed, detail, chainVerified, deepChecked}}
 */
export async function checkEntry(entry, { deep = false } = {}, cfg = loadConfig(), db = getDb(cfg)) {
  if (!entry) {
    return { passed: false, detail: 'no ledger entry', chainVerified: false, deepChecked: false };
  }
  const n = seqNumber(entry.seq);

  if (deep) {
    const entries = await db.ledgerAll();
    const result = verifyChain(entries, { deep: true });
    if (!result.ok) {
      return {
        passed: false,
        detail: `chain broken at seq ${result.firstBadSeq}`,
        chainVerified: false,
        deepChecked: true,
      };
    }
    // The supplied entry must itself recompute (guards a forged manifestHash
    // that keeps a copied entryHash), and must be present verbatim in the chain.
    if (!entryIntact(entry)) {
      return {
        passed: false,
        detail: 'entryHash recomputation mismatch for the supplied entry',
        chainVerified: false,
        deepChecked: true,
      };
    }
    const present = entries.some((e) => e.seq === entry.seq && e.entryHash === entry.entryHash);
    if (!present) {
      return { passed: false, detail: `entry ${entry.seq} not found in ledger`, chainVerified: false, deepChecked: true };
    }
    return {
      passed: true,
      detail: `hash-chained to genesis (${entries.length} entries verified)`,
      chainVerified: true,
      deepChecked: true,
    };
  }

  const prev = n > 1 ? await db.ledgerGet(padSeq(n - 1)) : null;
  const { hashOk, linkOk } = checkLink(entry, prev);
  if (hashOk && linkOk) {
    return {
      passed: true,
      detail: n === 1 ? 'genesis entry, hash recomputed' : `entryHash recomputed, linked to ${padSeq(n - 1)}`,
      chainVerified: true,
      deepChecked: false,
    };
  }
  return {
    passed: false,
    detail: hashOk ? 'previous link mismatch' : 'entryHash recomputation mismatch',
    chainVerified: false,
    deepChecked: false,
  };
}
