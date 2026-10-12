// Authenticated API routes (docs/API.md — all non /public, /internal, /meta,
// /dev routes). Every handler receives the router ctx with ctx.actor set.

import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { respond, contentDisposition } from '../http.js';
import { makeHandler } from '../lambda.js';
import { getDb } from '../services/db.js';
import * as cases from '../services/cases.js';
import * as evidenceSvc from '../services/evidence.js';
import * as captureSvc from '../services/capture.js';
import * as pkgSvc from '../services/package.js';
import * as shareSvc from '../services/share.js';
import * as auditSvc from '../services/audit.js';
import { runForensics } from '../services/forensics.js';

const json = (body, status = 200) => respond(status, body);
const PLANS = ['free', 'personal', 'pro', 'enterprise'];

function deps(ctx) {
  const cfg = loadConfig();
  return { cfg, db: getDb(cfg), ip: ctx.ip };
}

async function currentUser(ctx, cfg, db) {
  const sub = ctx.actor.sub;
  let u = await db.getUser(sub);
  if (!u) {
    u = {
      id: sub,
      email: ctx.actor.email || `${sub}@users.local`,
      name: ctx.actor.name || (ctx.actor.email ? ctx.actor.email.split('@')[0] : 'User'),
      plan: 'free',
      mfaEnabled: false,
      createdAt: new Date().toISOString(),
    };
    await db.putUser(u);
  }
  return u;
}

export const routes = [
  // --- user -----------------------------------------------------------------
  {
    method: 'GET', path: '/me', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await currentUser(ctx, cfg, db));
    },
  },
  {
    method: 'PATCH', path: '/me', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      const u = await currentUser(ctx, cfg, db);
      const body = ctx.body || {};
      const patch = {};
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) {
          throw new AppError('validation_error', 'name must be a non-empty string');
        }
        if (body.name.length > 100) throw new AppError('validation_error', 'name must be at most 100 characters');
        patch.name = body.name.trim();
      }
      if (body.plan !== undefined) {
        if (!PLANS.includes(body.plan)) {
          throw new AppError('validation_error', `plan must be one of ${PLANS.join('|')}`);
        }
        patch.plan = body.plan;
      }
      const updated = { ...u, ...patch };
      await db.putUser(updated);
      return json(updated);
    },
  },

  // --- cases ----------------------------------------------------------------
  {
    method: 'GET', path: '/cases', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await cases.listCases(ctx.actor, cfg, db));
    },
  },
  {
    method: 'POST', path: '/cases', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await cases.createCase(ctx.actor, ctx.body, cfg, db), 201);
    },
  },
  {
    method: 'GET', path: '/cases/:caseId', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await cases.getCaseDetail(ctx.params.caseId, ctx.actor, cfg, db));
    },
  },
  {
    method: 'PATCH', path: '/cases/:caseId', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await cases.updateCase(ctx.params.caseId, ctx.actor, ctx.body, cfg, db));
    },
  },
  {
    method: 'DELETE', path: '/cases/:caseId', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await cases.deleteCase(ctx.params.caseId, ctx.actor, cfg, db));
    },
  },

  // --- evidence -------------------------------------------------------------
  {
    method: 'POST', path: '/evidence', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      const res = await evidenceSvc.createEvidence(ctx.actor, ctx.body, { cfg, db, ip: ctx.ip });
      return json(res, 201);
    },
  },
  {
    // local mode: backend-proxied raw upload (the uploadUrl). Auth-free by
    // design (like a presigned PUT) — gated by the unguessable evidence id and
    // the x-client-sha256 header that must match the record.
    method: 'PUT', path: '/evidence/upload/:id', auth: false,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      if (!Buffer.isBuffer(ctx.raw) || ctx.raw.length === 0) {
        throw new AppError('validation_error', 'Request body is required (raw file bytes)');
      }
      return json(await evidenceSvc.receiveUpload(ctx.params.id, {
        headers: ctx.headers,
        bytes: ctx.raw,
        cfg,
        db,
      }));
    },
  },
  {
    method: 'GET', path: '/evidence', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await evidenceSvc.listEvidenceItems(ctx.actor, { caseId: ctx.query.caseId }, cfg, db));
    },
  },
  {
    method: 'GET', path: '/evidence/:id', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      const ev = await evidenceSvc.getEvidenceOwned(ctx.params.id, ctx.actor, cfg, db);
      await auditSvc.appendAudit({ evidenceId: ev.id, actor: ctx.actor.sub, action: 'view', ip: ctx.ip }, cfg, db);
      return json(await evidenceSvc.withShares(ev, cfg, db));
    },
  },
  {
    method: 'POST', path: '/evidence/:id/seal', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      const res = await evidenceSvc.requestSeal(ctx.params.id, ctx.actor, { cfg, db, ip: ctx.ip });
      return json(res);
    },
  },
  {
    method: 'GET', path: '/evidence/:id/download', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      const { bytes, filename, mimeType } = await evidenceSvc.downloadEvidence(
        ctx.params.id, ctx.actor, { ip: ctx.ip }, cfg, db,
      );
      return respond(200, bytes, {
        'content-type': mimeType || 'application/octet-stream',
        'content-disposition': contentDisposition(filename),
        'content-length': String(bytes.length),
      });
    },
  },
  {
    method: 'DELETE', path: '/evidence/:id', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await evidenceSvc.deleteEvidence(ctx.params.id, ctx.actor, cfg, db));
    },
  },
  {
    method: 'POST', path: '/evidence/:id/forensics', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await runForensics(ctx.params.id, { actor: ctx.actor, cfg, db }));
    },
  },

  // --- cloud page capture ---------------------------------------------------
  {
    method: 'POST', path: '/captures', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await captureSvc.createCapture(ctx.actor, ctx.body, { cfg, db }), 201);
    },
  },
  {
    method: 'GET', path: '/captures', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await captureSvc.listCaptures(ctx.actor, { caseId: ctx.query.caseId }, { cfg, db }));
    },
  },
  {
    method: 'GET', path: '/captures/:captureId', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await captureSvc.getCaptureForClient(ctx.params.captureId, ctx.actor, { cfg, db }));
    },
  },

  // --- packages -------------------------------------------------------------
  {
    method: 'GET', path: '/packages', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await pkgSvc.listPackages(ctx.actor, { caseId: ctx.query.caseId }, { cfg, db }));
    },
  },
  {
    method: 'POST', path: '/packages', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      return json(await pkgSvc.createPackage(ctx.actor, ctx.body, { cfg, db }), 201);
    },
  },
  {
    method: 'GET', path: '/packages/:id', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      const pkg = await pkgSvc.getPackageOwned(ctx.params.id, ctx.actor, { cfg, db });
      return json(pkgSvc.shapePackage(pkg, cfg));
    },
  },
  {
    method: 'GET', path: '/packages/:id/download', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      const { bytes, filename } = await pkgSvc.downloadPackage(ctx.params.id, ctx.actor, { cfg, db });
      const pkg = await pkgSvc.getPackageOwned(ctx.params.id, ctx.actor, { cfg, db });
      for (const evId of pkg.evidenceIds) {
        await auditSvc.appendAudit({ evidenceId: evId, actor: ctx.actor.sub, action: 'download', ip: ctx.ip }, cfg, db);
      }
      return respond(200, bytes, {
        'content-type': 'application/zip',
        'content-disposition': contentDisposition(filename),
        'content-length': String(bytes.length),
      });
    },
  },

  // --- shares ---------------------------------------------------------------
  {
    method: 'GET', path: '/evidence/:id/shares', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      const ev = await evidenceSvc.getEvidenceOwned(ctx.params.id, ctx.actor, cfg, db);
      return json(await shareSvc.listShares(ev.id, cfg, db));
    },
  },
  {
    method: 'POST', path: '/evidence/:id/shares', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      const ev = await evidenceSvc.getEvidenceOwned(ctx.params.id, ctx.actor, cfg, db);
      const body = ctx.body || {};
      const share = await shareSvc.createShare({
        scope: 'evidence',
        targetId: ev.id,
        includeDownload: body.includeDownload !== false,
        expiresInHours: body.expiresInHours,
      }, cfg, db);
      await auditSvc.appendAudit({ evidenceId: ev.id, actor: ctx.actor.sub, action: 'share', ip: ctx.ip }, cfg, db);
      return json(share, 201);
    },
  },
  {
    method: 'DELETE', path: '/shares/:shareId', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      const share = await db.getShareById(ctx.params.shareId);
      if (!share) throw new AppError('not_found', 'Share not found');
      if (share.targetId.startsWith('ev_')) {
        await evidenceSvc.getEvidenceOwned(share.targetId, ctx.actor, cfg, db);
      } else {
        await pkgSvc.getPackageOwned(share.targetId, ctx.actor, { cfg, db });
      }
      await shareSvc.revokeShare(share.id, cfg, db);
      return json({ ok: true });
    },
  },

  // --- audit ----------------------------------------------------------------
  {
    method: 'GET', path: '/evidence/:id/audit', auth: true,
    handler: async (ctx) => {
      const { cfg, db } = deps(ctx);
      const ev = await evidenceSvc.getEvidenceOwned(ctx.params.id, ctx.actor, cfg, db);
      return json(await auditSvc.listAudit(ev.id, cfg, db));
    },
  },
];

/** Lambda handler (API Gateway HTTP API, payload v2). */
export const handler = makeHandler(routes);
