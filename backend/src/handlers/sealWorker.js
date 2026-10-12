// SQS event source -> seal.js (aws mode async sealing).

import { runSeal } from '../services/seal.js';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';

/**
 * SQS handler: records are { evidenceId } (or a bare evidence id string).
 * Transient failures throw (=> SQS retry => DLQ after maxReceiveCount);
 * deterministic client errors (missing/not uploaded/already sealed) are
 * logged and dropped so they never poison the queue.
 */
export async function handler(event) {
  const cfg = loadConfig();
  const failures = [];
  for (const record of event.Records || []) {
    let evidenceId;
    let opts = {};
    try {
      const body = JSON.parse(record.body || '{}');
      if (typeof body === 'string') {
        evidenceId = body;
      } else {
        evidenceId = body.evidenceId;
        opts = { actor: body.actor, ip: body.ip };
      }
    } catch {
      evidenceId = String(record.body || '').trim();
    }
    if (!evidenceId) {
      console.warn('[sealWorker] record without evidenceId, skipping');
      continue;
    }
    try {
      const ev = await runSeal(evidenceId, cfg, undefined, opts);
      console.log(`[sealWorker] sealed ${evidenceId} (ledger seq ${ev.proof?.ledger?.seq})`);
    } catch (e) {
      if (e instanceof AppError && ['not_found', 'conflict', 'hash_mismatch', 'payload_too_large'].includes(e.code)) {
        console.warn(`[sealWorker] dropping ${evidenceId}: ${e.code} ${e.message}`);
        continue;
      }
      failures.push(e);
      console.error(`[sealWorker] ${evidenceId} failed:`, e.message);
    }
  }
  if (failures.length) {
    throw new Error(`${failures.length} seal job(s) failed: ${failures[0].message}`);
  }
  return { ok: true };
}
