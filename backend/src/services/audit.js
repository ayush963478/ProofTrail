// Access audit log (docs/DATA-MODEL.md AUDIT table).
//
// Every view/download/share/verify/create/seal is appended. Only an IP hash is
// stored: ipHash = sha256(ip + AUDIT_SALT). TTL = now + AUDIT_TTL_DAYS (365).

import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { getDb } from './db.js';

export const AUDIT_ACTIONS = ['view', 'download', 'share', 'verify', 'create', 'seal'];

export function ipHash(ip, cfg = loadConfig()) {
  return crypto.createHash('sha256').update(`${ip || 'unknown'}${cfg.auditSalt}`).digest('hex');
}

/**
 * Append an access-log entry.
 * @param {{evidenceId, actor, action, ip, time?}} entry
 */
export async function appendAudit({ evidenceId, actor, action, ip, time }, cfg = loadConfig(), db = getDb(cfg)) {
  if (!evidenceId) throw new AppError('validation_error', 'evidenceId is required for audit');
  if (!AUDIT_ACTIONS.includes(action)) throw new AppError('validation_error', `action must be one of ${AUDIT_ACTIONS.join('|')}`);
  const t = time || new Date().toISOString();
  const rand = crypto.randomBytes(6).toString('hex');
  const entry = {
    id: `${t}#${action}#${rand}`,
    evidenceId,
    actor: actor || 'anonymous',
    action,
    time: t,
    ipHash: ipHash(ip, cfg),
    expiresAt: new Date(Date.now() + cfg.auditTtlDays * 86400 * 1000).toISOString(),
  };
  return db.appendAudit(entry);
}

export async function listAudit(evidenceId, cfg = loadConfig(), db = getDb(cfg)) {
  return (await db.listAudit(evidenceId)).map(({ id, evidenceId: eid, actor, action, time, ipHash: h }) => ({
    id,
    evidenceId: eid,
    actor,
    action,
    time,
    ipHash: h,
  }));
}
