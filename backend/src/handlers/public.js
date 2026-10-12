// Public + meta + dev + internal routes (docs/API.md).

import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { respond, contentDisposition } from '../http.js';
import { makeHandler } from '../lambda.js';
import { getDb } from '../services/db.js';
import { issueDevToken } from '../auth.js';
import { validateShare } from '../services/share.js';
import { appendAudit } from '../services/audit.js';
import { evidenceChecks, publicEvidenceView } from '../services/verify.js';
import { evidenceBytes } from '../services/seal.js';
import { getPublicKey } from '../crypto/keys.js';
import { isSha256Hex } from '../crypto/hash.js';
import { completeCapture } from '../services/capture.js';
import { packageBytesByToken, getPackageById } from '../services/package.js';

const json = (body, status = 200) => respond(status, body);

/** Blueprint §9 tiers (GET /meta). */
export const TIERS = [
  { id: 'free', name: 'Free', audience: 'Individuals', offer: 'Limited captures per month, public verification link' },
  { id: 'personal', name: 'Personal', audience: 'Individuals, freelancers', offer: 'More storage, cloud page capture, case folders, PDF reports' },
  { id: 'pro', name: 'Pro', audience: 'Small firms, NGOs', offer: 'Team access, branded reports, bulk export, API' },
  { id: 'enterprise', name: 'Enterprise', audience: 'HR, compliance, legal teams', offer: 'SSO, audit exports, retention policies, SLA' },
];

function deps() {
  const cfg = loadConfig();
  return { cfg, db: getDb(cfg) };
}

function shareView(share) {
  return {
    createdAt: share.createdAt,
    expiresAt: share.expiresAt ?? null,
    includeDownload: share.includeDownload !== false,
  };
}

async function buildEvidenceVerify(share, ev, deep, cfg, db, ip) {
  const { proof, checks, checksPassed, checksTotal } = await evidenceChecks(ev, { deep }, cfg, db);
  await appendAudit({ evidenceId: ev.id, actor: 'anonymous', action: 'verify', ip }, cfg, db);
  return {
    scope: 'evidence',
    kind: 'evidence',
    share: shareView(share, cfg),
    evidence: publicEvidenceView(ev),
    proof,
    checks,
    checksPassed,
    checksTotal,
  };
}

async function buildPackageVerify(share, pkg, deep, cfg, db, ip) {
  const items = [];
  for (const evId of pkg.evidenceIds) {
    const ev = await db.getEvidence(evId);
    if (!ev || ev.deletedAt) continue;
    const { proof, checks, checksPassed, checksTotal } = await evidenceChecks(ev, { deep }, cfg, db);
    await appendAudit({ evidenceId: ev.id, actor: 'anonymous', action: 'verify', ip }, cfg, db);
    items.push({ evidence: publicEvidenceView(ev), proof, checks, checksPassed, checksTotal });
  }
  // aggregate checks across all items (a package passes only if every item passes)
  const names = new Set(items.flatMap((i) => i.checks.map((c) => c.name)));
  const checks = [...names].map((name) => {
    const per = items.map((i) => i.checks.find((c) => c.name === name)).filter(Boolean);
    const passed = per.length > 0 && per.every((c) => c.passed);
    const failing = per.filter((c) => !c.passed).map((c) => c.detail);
    return {
      name,
      passed,
      detail: passed
        ? `all ${per.length} item(s) pass "${name}"`
        : `failing in ${failing.length} item(s): ${failing.slice(0, 2).join(' | ')}`,
    };
  });
  return {
    scope: 'package',
    kind: 'package',
    share: shareView(share, cfg),
    package: { id: pkg.id, generatedAt: pkg.generatedAt, itemCount: pkg.itemCount },
    items,
    checks,
    checksPassed: checks.filter((c) => c.passed).length,
    checksTotal: checks.length,
  };
}

const devTokenRoute = {
  method: 'POST', path: '/dev/token', auth: false,
  handler: async (ctx) => {
    const { cfg, db } = deps();
    if (cfg.authMode !== 'dev') throw new AppError('not_found', 'Dev tokens are disabled (AUTH_MODE=cognito)');
    const body = ctx.body || {};
    const typedName = typeof body.name === 'string' ? body.name.trim() : '';
    if (typedName.length > 100) throw new AppError('validation_error', 'name must be at most 100 characters');
    const { token, expiresIn, user } = await issueDevToken(
      { email: body.email, name: typedName || undefined },
      cfg
    );
    // The profile row is created once per sub on first login. Persist the name
    // typed on this sign-in so GET /me (fetched immediately after login) shows
    // it instead of a name from an earlier session. Blank names never clobber
    // an edited profile.
    if (typedName) {
      const stored = await db.getUser(user.id);
      await db.putUser({
        id: user.id,
        email: user.email,
        name: typedName,
        plan: stored?.plan || 'free',
        mfaEnabled: stored?.mfaEnabled || false,
        createdAt: stored?.createdAt || new Date().toISOString(),
      });
    }
    return json({ token, expiresIn, user });
  },
};

export const routes = [
  // --- meta -----------------------------------------------------------------
  {
    method: 'GET', path: '/meta', auth: false,
    handler: async () => {
      const { cfg } = deps();
      return json({ appName: 'ProofTrail', authMode: cfg.authMode, mode: cfg.mode, tiers: TIERS });
    },
  },

  // --- dev auth (only when authMode === dev) --------------------------------
  ...(loadConfig().authMode === 'dev' ? [devTokenRoute] : []),

  // --- public verification --------------------------------------------------
  {
    method: 'POST', path: '/public/verify', auth: false,
    handler: async (ctx) => {
      const { cfg, db } = deps();
      const sha256 = String(ctx.body?.sha256 || '').toLowerCase();
      if (!isSha256Hex(sha256)) throw new AppError('validation_error', 'sha256 must be a 64-char hex SHA-256');
      const ev = await db.findEvidenceBySha256(sha256);
      return json({ exists: !!ev, sealedAt: ev?.proof?.sealedAt ?? null });
    },
  },
  {
    method: 'GET', path: '/public/verify/:token', auth: false,
    handler: async (ctx) => {
      const { cfg, db } = deps();
      const share = await validateShare(ctx.params.token, cfg, db);
      const deep = ctx.query.deep === '1' || ctx.query.deep === 'true';
      if (share.scope === 'package') {
        const pkg = await getPackageById(share.targetId, { cfg, db });
        if (!pkg) throw new AppError('not_found', 'Package not found');
        return json(await buildPackageVerify(share, pkg, deep, cfg, db, ctx.ip));
      }
      const ev = await db.getEvidence(share.targetId);
      if (!ev || ev.deletedAt) throw new AppError('not_found', 'Evidence not found');
      return json(await buildEvidenceVerify(share, ev, deep, cfg, db, ctx.ip));
    },
  },
  {
    method: 'GET', path: '/public/download/:token', auth: false,
    handler: async (ctx) => {
      const { cfg, db } = deps();
      const share = await validateShare(ctx.params.token, cfg, db);
      if (share.includeDownload === false) {
        throw new AppError('forbidden', 'This share does not allow downloads');
      }
      if (share.scope === 'package') {
        const { bytes, filename, pkg } = await packageBytesByToken(share, { cfg, db });
        for (const evId of pkg.evidenceIds) {
          await appendAudit({ evidenceId: evId, actor: 'anonymous', action: 'download', ip: ctx.ip }, cfg, db);
        }
        return respond(200, bytes, {
          'content-type': 'application/zip',
          'content-disposition': contentDisposition(filename),
          'content-length': String(bytes.length),
        });
      }
      const ev = await db.getEvidence(share.targetId);
      if (!ev || ev.deletedAt) throw new AppError('not_found', 'Evidence not found');
      const bytes = await evidenceBytes(ev, cfg);
      await appendAudit({ evidenceId: ev.id, actor: 'anonymous', action: 'download', ip: ctx.ip }, cfg, db);
      return respond(200, bytes, {
        'content-type': ev.mimeType || 'application/octet-stream',
        'content-disposition': contentDisposition(ev.filename),
        'content-length': String(bytes.length),
      });
    },
  },
  {
    method: 'GET', path: '/public/keys/:keyId', auth: false,
    handler: async (ctx) => {
      const { cfg } = deps();
      const key = await getPublicKey(ctx.params.keyId, cfg);
      return json({
        keyId: key.keyId,
        algorithm: key.algorithm,
        publicKeyPem: key.publicKeyPem,
        source: key.source,
      });
    },
  },
  {
    method: 'GET', path: '/public/anchors/:root', auth: false,
    handler: async (ctx) => {
      const { cfg, db } = deps();
      const root = String(ctx.params.root).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(root)) throw new AppError('not_found', 'Anchor root not found');
      const item = await db.getAnchorByRoot(root);
      if (!item) throw new AppError('not_found', 'Anchor root not found');
      return json({
        root: item.root,
        batchId: item.batchId,
        fromSeq: item.fromSeq,
        toSeq: item.toSeq,
        leafCount: item.leafCount,
        publishedAt: item.publishedAt,
        externalRef: item.externalRef ?? null,
      });
    },
  },

  // --- internal completion callback ----------------------------------------
  {
    method: 'POST', path: '/internal/captures/:id/complete', auth: false,
    handler: async (ctx) => {
      const { cfg, db } = deps();
      const token = ctx.headers['x-service-token'];
      if (!token || token !== cfg.serviceToken) {
        throw new AppError('unauthorized', 'Missing or invalid x-service-token header');
      }
      const body = ctx.body || {};
      if (!['queued', 'running', 'done', 'failed'].includes(body.status)) {
        throw new AppError('validation_error', 'status must be one of queued|running|done|failed');
      }
      const job = await completeCapture(ctx.params.id, {
        status: body.status,
        error: body.error,
        evidenceId: body.evidenceId,
        screenshotKey: body.screenshotKey,
      }, { cfg, db });
      return json({ ok: true, evidenceId: job.evidenceId ?? null, status: job.status });
    },
  },
];

/** Lambda handler (API Gateway HTTP API, payload v2). */
export const handler = makeHandler(routes);
