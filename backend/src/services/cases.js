// Case CRUD (docs/API.md Cases routes).

import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { getDb } from './db.js';

function nowIso() { return new Date().toISOString(); }

function validateTitle(title) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new AppError('validation_error', 'title is required');
  }
  if (title.length > 200) throw new AppError('validation_error', 'title must be at most 200 characters');
  return title.trim();
}

export async function createCase(actor, body, cfg = loadConfig(), db = getDb(cfg)) {
  const title = validateTitle(body?.title);
  const description = body?.description === undefined || body?.description === null
    ? ''
    : String(body.description);
  if (description.length > 5000) throw new AppError('validation_error', 'description must be at most 5000 characters');
  const createdAt = nowIso();
  const c = {
    id: `case_${crypto.randomBytes(8).toString('hex')}`,
    ownerId: actor.sub,
    title,
    description,
    evidenceCount: 0,
    createdAt,
    updatedAt: createdAt,
    sharedWith: [],
  };
  return db.createCase(c);
}

export async function listCases(actor, cfg = loadConfig(), db = getDb(cfg)) {
  const cases = await db.listCases(actor.sub);
  const evidence = await db.listEvidence(actor.sub);
  const counts = new Map();
  for (const e of evidence) {
    if (e.caseId) counts.set(e.caseId, (counts.get(e.caseId) || 0) + 1);
  }
  return cases.map((c) => ({ ...c, evidenceCount: counts.get(c.id) || 0 }));
}

/** Fetch a case the actor owns, else 404 (never leak other users' cases). */
export async function getCaseOwned(caseId, actor, cfg = loadConfig(), db = getDb(cfg)) {
  const c = await db.getCase(caseId);
  if (!c || c.deletedAt || c.ownerId !== actor.sub) throw new AppError('not_found', 'Case not found');
  return c;
}

/** Case with a fresh evidenceCount (used by GET /cases/{id}). */
export async function getCaseDetail(caseId, actor, cfg = loadConfig(), db = getDb(cfg)) {
  const c = await getCaseOwned(caseId, actor, cfg, db);
  const evidence = await db.listEvidence(actor.sub);
  return { ...c, evidenceCount: evidence.filter((e) => e.caseId === caseId).length };
}

export async function updateCase(caseId, actor, body, cfg = loadConfig(), db = getDb(cfg)) {
  await getCaseOwned(caseId, actor, cfg, db);
  const patch = { updatedAt: nowIso() };
  if (body?.title !== undefined) patch.title = validateTitle(body.title);
  if (body?.description !== undefined) patch.description = String(body.description);
  return db.updateCase(caseId, patch);
}

/** Deletes the case + tombstones its evidence. Returns {ok:true}. */
export async function deleteCase(caseId, actor, cfg = loadConfig(), db = getDb(cfg)) {
  await getCaseOwned(caseId, actor, cfg, db);
  const evidence = (await db.listEvidence(actor.sub)).filter((e) => e.caseId === caseId);
  const ts = nowIso();
  for (const e of evidence) {
    await db.updateEvidence(e.id, { deletedAt: ts, updatedAt: ts });
  }
  await db.deleteCase(caseId);
  return { ok: true };
}
