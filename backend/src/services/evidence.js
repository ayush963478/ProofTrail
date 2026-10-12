// Evidence lifecycle (docs/API.md Evidence routes).

import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { getDb } from './db.js';
import { isSha256Hex, sha256Hex } from '../crypto/hash.js';
import { presignUpload, putStagingBytes, stagingKeyFor, vaultKeyFor } from './vault.js';
import { runSeal, verifyStagedHash, evidenceBytes } from './seal.js';
import { appendAudit } from './audit.js';
import { listShares } from './share.js';

export const EVIDENCE_TYPES = ['photo', 'page', 'chat', 'file', 'audio', 'video', 'text'];
export const CAPTURE_METHODS = ['upload', 'cloud_url', 'share_import', 'screen'];

const nowIso = () => new Date().toISOString();

function sanitizeFilename(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new AppError('validation_error', 'filename is required');
  }
  // strip directory components + control chars / quotes
  const base = name.replace(/\\/g, '/').split('/').pop().replace(/[\x00-\x1f\x7f"]/g, '').trim();
  if (!base) throw new AppError('validation_error', 'filename is invalid');
  if (base.length > 255) throw new AppError('validation_error', 'filename must be at most 255 characters');
  return base;
}

export function normalizeCapture(capture) {
  const c = capture && typeof capture === 'object' ? capture : {};
  let gps = null;
  if (c.gps && typeof c.gps === 'object' &&
      Number.isFinite(Number(c.gps.lat)) && Number.isFinite(Number(c.gps.lng))) {
    gps = { lat: Number(c.gps.lat), lng: Number(c.gps.lng) };
  }
  return {
    device: c.device === undefined || c.device === null ? null : String(c.device),
    appVersion: c.appVersion === undefined || c.appVersion === null ? null : String(c.appVersion),
    url: c.url === undefined || c.url === null ? null : String(c.url),
    gps,
    clientTime: c.clientTime === undefined || c.clientTime === null ? null : String(c.clientTime),
    serverTime: nowIso(),
    userAgent: c.userAgent === undefined || c.userAgent === null ? null : String(c.userAgent),
  };
}

/** POST /evidence */
export async function createEvidence(actor, body, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const db = opts.db || getDb(cfg);
  if (!body || typeof body !== 'object') throw new AppError('validation_error', 'Request body is required');
  const type = body.type;
  if (!EVIDENCE_TYPES.includes(type)) {
    throw new AppError('validation_error', `type must be one of ${EVIDENCE_TYPES.join('|')}`);
  }
  const filename = sanitizeFilename(body.filename);
  if (typeof body.mimeType !== 'string' || !body.mimeType.includes('/')) {
    throw new AppError('validation_error', 'mimeType is required (e.g. image/png)');
  }
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0) throw new AppError('validation_error', 'size must be a positive integer');
  if (size > cfg.maxEvidenceSize) throw new AppError('payload_too_large', 'size exceeds MAX_EVIDENCE_SIZE');
  const clientSha256 = String(body.clientSha256 || '').toLowerCase();
  if (!isSha256Hex(clientSha256)) throw new AppError('validation_error', 'clientSha256 must be a 64-char hex SHA-256');
  const captureMethod = body.captureMethod;
  if (!CAPTURE_METHODS.includes(captureMethod)) {
    throw new AppError('validation_error', `captureMethod must be one of ${CAPTURE_METHODS.join('|')}`);
  }

  let caseId = body.caseId ?? null;
  if (caseId !== null && caseId !== undefined && caseId !== '') {
    const c = await db.getCase(String(caseId));
    if (!c || c.deletedAt || c.ownerId !== actor.sub) throw new AppError('not_found', 'Case not found');
    caseId = c.id;
  } else {
    caseId = null;
  }

  const createdAt = nowIso();
  const id = `ev_${crypto.randomBytes(10).toString('hex')}`;
  const record = {
    id,
    caseId,
    ownerId: actor.sub,
    type,
    filename,
    mimeType: body.mimeType,
    size,
    sha256: null,
    clientSha256,
    hashMatched: false,
    storageKey: vaultKeyFor(id, filename, new Date(createdAt)),
    status: 'pending_upload',
    sealError: null,
    captureMethod,
    capture: normalizeCapture(body.capture),
    proof: null,
    forensicReport: null,
    shares: [],
    retentionLock: false,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  await db.putEvidence(record);
  await appendAudit({ evidenceId: id, actor: actor.sub, action: 'create', ip: opts.ip }, cfg, db);

  // uploadUrl / uploadHeaders per mode (API.md POST /evidence)
  if (cfg.mode === 'aws') {
    const uploadUrl = await presignUpload(stagingKeyFor(id), {
      mimeType: record.mimeType,
      metadata: { 'client-sha256': clientSha256, 'evidence-id': id },
    }, cfg);
    return {
      id,
      status: 'pending_upload',
      uploadUrl,
      uploadHeaders: {
        'x-amz-meta-client-sha256': clientSha256,
        'x-amz-meta-evidence-id': id,
      },
    };
  }
  return {
    id,
    status: 'pending_upload',
    uploadUrl: `${cfg.apiBaseUrl}/evidence/upload/${id}`,
    uploadHeaders: { 'x-client-sha256': clientSha256 },
  };
}

/** PUT /evidence/upload/{id} (local mode proxy). */
export async function receiveUpload(id, { headers, bytes, cfg = loadConfig(), db = getDb(cfg) }) {
  const ev = await db.getEvidence(id);
  if (!ev || ev.deletedAt) throw new AppError('not_found', 'Evidence not found');
  if (!['pending_upload', 'uploaded', 'failed'].includes(ev.status)) {
    throw new AppError('conflict', `Cannot accept upload in status "${ev.status}"`);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new AppError('validation_error', 'Empty upload body');
  }
  if (bytes.length > cfg.maxEvidenceSize) {
    throw new AppError('payload_too_large', 'Uploaded file exceeds MAX_EVIDENCE_SIZE');
  }
  const headerSha = String(headers['x-client-sha256'] || '').toLowerCase();
  if (!headerSha) throw new AppError('validation_error', 'x-client-sha256 header is required');
  if (headerSha !== ev.clientSha256) {
    throw new AppError('validation_error', 'x-client-sha256 header does not match the evidence clientSha256');
  }
  await putStagingBytes(stagingKeyFor(id), bytes, cfg);
  await db.updateEvidence(id, { status: 'uploaded', sealError: null, size: bytes.length, updatedAt: nowIso() });
  return { ok: true };
}

/** Fetch an evidence item the actor owns (404 for others' items). */
export async function getEvidenceOwned(id, actor, cfg = loadConfig(), db = getDb(cfg)) {
  const ev = await db.getEvidence(id);
  if (!ev || ev.deletedAt || ev.ownerId !== actor.sub) throw new AppError('not_found', 'Evidence not found');
  return ev;
}

/** Evidence record + shares (API.md full record includes `shares`). */
export async function withShares(ev, cfg = loadConfig(), db = getDb(cfg)) {
  const shares = await listShares(ev.id, cfg, db);
  return { ...ev, shares };
}

export async function listEvidenceItems(actor, { caseId } = {}, cfg = loadConfig(), db = getDb(cfg)) {
  let items = await db.listEvidence(actor.sub);
  if (caseId) items = items.filter((e) => e.caseId === caseId);
  const out = [];
  for (const e of items) out.push(await withShares(e, cfg, db));
  return out;
}

/**
 * POST /evidence/{id}/seal
 * Pre-checks the staged hash so a mismatch returns 422 on the request path,
 * then runs the pipeline async (SQS in aws, inline in local).
 */
export async function requestSeal(id, actor, { cfg = loadConfig(), db = getDb(cfg), schedule, ip } = {}) {
  const ev = await getEvidenceOwned(id, actor, cfg, db);
  if (ev.status === 'sealed') throw new AppError('conflict', 'Evidence is already sealed');
  // throws AppError(422|409|413) and marks the record failed on mismatch
  await verifyStagedHash(id, cfg, db);
  await db.updateEvidence(id, { status: 'sealing', sealError: null, updatedAt: nowIso() });
  const runner = schedule || scheduleSeal;
  runner(id, cfg, { actor: actor.sub, ip });
  return { id, status: 'sealing' };
}

/** Queue (aws/SQS) or inline (local) seal execution. */
export function scheduleSeal(evidenceId, cfg = loadConfig(), opts = {}) {
  if (cfg.mode === 'aws' && cfg.sqsSealQueueUrl) {
    (async () => {
      try {
        const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
        const client = new SQSClient({ region: cfg.cognito.region || process.env.AWS_REGION });
        await client.send(new SendMessageCommand({
          QueueUrl: cfg.sqsSealQueueUrl,
          MessageBody: JSON.stringify({ evidenceId, actor: opts.actor || 'system', ip: opts.ip || 'internal' }),
        }));
      } catch (e) {
        console.error(`[seal] SQS enqueue failed (${e.message}); running inline`);
        setImmediate(() => runSeal(evidenceId, cfg, undefined, opts).catch((err) => console.error(`[seal] ${evidenceId}: ${err.message}`)));
      }
    })();
    return;
  }
  setImmediate(() => {
    runSeal(evidenceId, cfg, undefined, opts).catch((err) => console.error(`[seal] ${evidenceId}: ${err.code || 'error'} ${err.message}`));
  });
}

/** GET /evidence/{id}/download — raw bytes, audit-logged. */
export async function downloadEvidence(id, actor, { ip } = {}, cfg = loadConfig(), db = getDb(cfg)) {
  const ev = await getEvidenceOwned(id, actor, cfg, db);
  const bytes = await evidenceBytes(ev, cfg);
  await appendAudit({ evidenceId: id, actor: actor.sub, action: 'download', ip }, cfg, db);
  return { bytes, filename: ev.filename, mimeType: ev.mimeType };
}

/** DELETE /evidence/{id} — tombstone (409 when retentionLock). */
export async function deleteEvidence(id, actor, cfg = loadConfig(), db = getDb(cfg)) {
  const ev = await getEvidenceOwned(id, actor, cfg, db);
  if (ev.retentionLock) throw new AppError('conflict', 'Evidence is retention-locked and cannot be deleted');
  const ts = nowIso();
  await db.updateEvidence(id, { deletedAt: ts, updatedAt: ts });
  return { ok: true };
}

/** Re-export for handlers. */
export { sha256Hex };
