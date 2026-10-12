// Cloud page capture orchestration (docs/API.md Capture routes).
//
// aws   — ECS Fargate RunTask (env CAPTURE_CLUSTER / CAPTURE_TASK_DEF /
//         CAPTURE_SUBNETS / CAPTURE_SG) with env overrides.
// local — spawn child process `node capture-service/src/index.js --job <id> ...`
//         (501 not_implemented with a helpful message when the capture-service
//         dependencies are missing).
//
// LAZY COMPLETION: when GET /captures/{id} sees status done && no evidenceId,
// the backend creates the EvidenceItem from the stored capture artifacts
// (server-side trusted) and seals it via seal.js — same for the internal
// completion callback route.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, REPO_ROOT } from '../config.js';
import { AppError } from '../errors.js';
import { getDb } from './db.js';
import { sha256Hex } from '../crypto/hash.js';
import { putStagingBytes, getStagingBytes, stagingKeyFor } from './vault.js';
import { runSeal } from './seal.js';
import { appendAudit } from './audit.js';
import { normalizeCapture } from './evidence.js';

const nowIso = () => new Date().toISOString();

/** CaptureJob per API.md. */
function jobShape(job) {
  const { id, url, status, error, evidenceId, caseId, createdAt, updatedAt, screenshotKey } = job;
  return { id, url, status, error, evidenceId, caseId, createdAt, updatedAt, ...(screenshotKey ? { screenshotKey } : {}) };
}

function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new AppError('validation_error', 'url must be a valid absolute URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError('validation_error', 'only http/https URLs can be captured');
  }
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host === 'metadata.google.internal' || host === '169.254.169.254' ||
    /^(127\.|0\.0\.0\.0|::1|fe80:)/.test(host)
  ) {
    throw new AppError('validation_error', 'refusing to capture private/metadata addresses');
  }
  return u.toString();
}

// ---------------------------------------------------------------------------
// create / list / get
// ---------------------------------------------------------------------------

export async function createCapture(actor, body, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const db = opts.db || getDb(cfg);
  if (!body || !body.url) {
    throw new AppError('validation_error', 'url is required');
  }
  const url = assertSafeUrl(body.url);

  let caseId = body.caseId ?? null;
  if (caseId) {
    const c = await db.getCase(String(caseId));
    if (!c || c.deletedAt || c.ownerId !== actor.sub) throw new AppError('not_found', 'Case not found');
    caseId = c.id;
  }

  const createdAt = nowIso();
  const job = {
    id: `cap_${crypto.randomBytes(8).toString('hex')}`,
    url,
    status: 'queued',
    error: null,
    evidenceId: null,
    caseId,
    ownerId: actor.sub,
    screenshotKey: null,
    waitForContent: body.waitForContent === true,
    createdAt,
    updatedAt: createdAt,
  };
  await db.putCapture(job);

  try {
    await startCapture(job, cfg, db);
  } catch (e) {
    if (e instanceof AppError && e.code === 'not_implemented') {
      // helpful 501 — job stays queued for when deps are installed
      throw e;
    }
    await db.updateCapture(job.id, { status: 'failed', error: e.message, updatedAt: nowIso() });
    throw e;
  }
  return { captureId: job.id, status: 'queued' };
}

export async function listCaptures(actor, { caseId } = {}, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const db = opts.db || getDb(cfg);
  let jobs = await db.listCaptures(actor.sub);
  if (caseId) jobs = jobs.filter((j) => j.caseId === caseId);
  return jobs.map(jobShape);
}

export async function getCaptureOwned(id, actor, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const db = opts.db || getDb(cfg);
  const job = await db.getCapture(id);
  if (!job || job.ownerId !== actor.sub) throw new AppError('not_found', 'Capture not found');
  return job;
}

/**
 * GET /captures/{id} with lazy completion.
 * Returns the CaptureJob shape (status "done" + evidenceId once completed).
 */
export async function getCaptureForClient(id, actor, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const db = opts.db || getDb(cfg);
  let job = await getCaptureOwned(id, actor, opts);
  if (job.status === 'done' && !job.evidenceId) {
    job = (await completing.get(id)?.catch(() => null)) || job;
    if (!job.evidenceId) {
      job = await completeCapture(id, { status: 'done' }, opts);
    }
  }
  return jobShape(job);
}

// ---------------------------------------------------------------------------
// completion
// ---------------------------------------------------------------------------

const completing = new Map(); // captureId -> Promise<job>

/** Read the screenshot artifact for a finished capture (aws: S3, local: fs). */
async function readScreenshot(job, cfg) {
  const key = job.screenshotKey || `captures/${job.id}/screenshot.png`;
  if (cfg.mode === 'aws') {
    return { bytes: await getStagingBytes(key, cfg), key };
  }
  const p = path.join(cfg.captureDir, job.id, 'screenshot.png');
  if (!fs.existsSync(p)) {
    // also accept an explicit local path written by the CLI
    if (job.screenshotKey && fs.existsSync(job.screenshotKey)) {
      return { bytes: fs.readFileSync(job.screenshotKey), key };
    }
    throw new AppError('not_found', `capture artifact screenshot.png missing for ${job.id}`);
  }
  return { bytes: fs.readFileSync(p), key };
}

/**
 * Mark a capture finished and (for done) create + seal the EvidenceItem.
 * Deduplicates concurrent calls. Returns the updated job.
 */
export async function completeCapture(captureId, { status, error, evidenceId, screenshotKey } = {}, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const db = opts.db || getDb(cfg);
  if (completing.has(captureId)) return completing.get(captureId);

  const promise = (async () => {
    const job = await db.getCapture(captureId);
    if (!job) throw new AppError('not_found', 'Capture not found');
    if (job.evidenceId) return job; // already completed
    const ts = nowIso();

    if (status === 'failed') {
      return db.updateCapture(captureId, { status: 'failed', error: error || 'capture failed', updatedAt: ts });
    }
    if (status !== 'done') {
      return db.updateCapture(captureId, { status: status || job.status, error: error ?? job.error, updatedAt: ts });
    }

    // --- create the EvidenceItem from server-side trusted artifacts ---
    const sk = screenshotKey || job.screenshotKey || `captures/${captureId}/screenshot.png`;
    const { bytes, key } = await readScreenshot({ ...job, screenshotKey: sk }, cfg);
    const evId = `ev_${crypto.randomBytes(10).toString('hex')}`;
    const filename = `${safeHost(job.url)}.png`;
    const createdAt = nowIso();
    const record = {
      id: evId,
      caseId: job.caseId || null,
      ownerId: job.ownerId,
      type: 'page',
      filename,
      mimeType: 'image/png',
      size: bytes.length,
      sha256: null,
      clientSha256: sha256Hex(bytes), // server-side claim: trusted cloud work
      hashMatched: false,
      storageKey: (await import('./vault.js')).vaultKeyFor(evId, filename, new Date(createdAt)),
      status: 'uploaded',
      sealError: null,
      captureMethod: 'cloud_url',
      capture: normalizeCapture({ url: job.url, clientTime: job.createdAt, serverTime: createdAt, userAgent: null }),
      proof: null,
      forensicReport: null,
      shares: [],
      retentionLock: false,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    };
    await db.putEvidence(record);
    await putStagingBytes(stagingKeyFor(evId), bytes, cfg);
    await appendAudit({ evidenceId: evId, actor: 'system', action: 'create', ip: 'internal' }, cfg, db);

    const updated = await db.updateCapture(captureId, {
      status: 'done', error: null, evidenceId: evId, screenshotKey: key, updatedAt: ts,
    });

    // seal async (client polls GET /evidence/{id})
    setImmediate(() => {
      runSeal(evId, cfg, db).catch((err) => console.error(`[capture] seal ${evId}: ${err.message}`));
    });
    return updated;
  })();

  completing.set(captureId, promise);
  try {
    return await promise;
  } finally {
    completing.delete(captureId);
  }
}

function safeHost(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname)
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 60) || 'capture';
  } catch {
    return 'capture';
  }
}

// ---------------------------------------------------------------------------
// starters
// ---------------------------------------------------------------------------

function localCaptureScript() {
  return path.join(REPO_ROOT, 'capture-service', 'src', 'index.js');
}

function localCaptureDepsMissing() {
  const script = localCaptureScript();
  if (!fs.existsSync(script)) return { missing: true, reason: 'capture-service/src/index.js not found' };
  const nm = path.join(REPO_ROOT, 'capture-service', 'node_modules');
  if (!fs.existsSync(nm)) return { missing: true, reason: 'capture-service/node_modules not installed' };
  return { missing: false };
}

async function startCapture(job, cfg, db) {
  if (cfg.mode === 'aws') return startCaptureEcs(job, cfg);
  return startCaptureLocal(job, cfg, db);
}

async function startCaptureEcs(job, cfg) {
  const missing = [];
  if (!cfg.captureCluster) missing.push('CAPTURE_CLUSTER');
  if (!cfg.captureTaskDef) missing.push('CAPTURE_TASK_DEF');
  if (cfg.captureSubnets.length === 0) missing.push('CAPTURE_SUBNETS');
  if (cfg.captureSecurityGroups.length === 0) missing.push('CAPTURE_SG');
  if (missing.length) {
    throw new AppError('not_implemented', `Cloud capture is not configured — set ${missing.join(', ')} (see infrastructure/README.md)`);
  }
  const { ECSClient, RunTaskCommand } = await import('@aws-sdk/client-ecs');
  const client = new ECSClient({ region: cfg.cognito.region || process.env.AWS_REGION });
  const env = [
    { name: 'MODE', value: 'fargate' },
    { name: 'CAPTURE_ID', value: job.id },
    { name: 'CAPTURE_TABLE', value: cfg.captureTable },
    { name: 'STAGING_BUCKET', value: cfg.stagingBucket },
    { name: 'API_BASE_URL', value: cfg.apiBaseUrl },
    { name: 'SERVICE_TOKEN', value: cfg.serviceToken },
    { name: 'CAPTURE_URL', value: job.url },
    { name: 'CAPTURE_WAIT_CONTENT', value: job.waitForContent ? '1' : '0' },
  ];
  const out = await client.send(new RunTaskCommand({
    cluster: cfg.captureCluster,
    taskDefinition: cfg.captureTaskDef,
    count: 1,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: cfg.captureSubnets,
        securityGroups: cfg.captureSecurityGroups,
        assignPublicIp: 'ENABLED',
      },
    },
    overrides: {
      containerOverrides: [{ name: process.env.CAPTURE_CONTAINER_NAME || 'capture', environment: env }],
    },
  }));
  const failures = out.failures || [];
  if (failures.length) {
    throw new Error(`ECS RunTask failed: ${failures.map((f) => f.reason || f.arn).join('; ')}`);
  }
  return out;
}

function startCaptureLocal(job, cfg, db) {
  const deps = localCaptureDepsMissing();
  if (deps.missing) {
    throw new AppError(
      'not_implemented',
      `Local cloud capture is not available: ${deps.reason}. Run \`cd capture-service && npm install\` first (downloads Chromium, ~150MB), then retry POST /captures.`,
    );
  }
  const outDir = path.join(cfg.captureDir, job.id);
  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    localCaptureScript(),
    '--job', job.id,
    '--url', job.url,
    '--out', outDir,
    '--api', cfg.apiBaseUrl,
    '--service-token', cfg.serviceToken,
  ];
  if (job.waitForContent) args.push('--wait');

  const child = spawn(process.execPath, args, {
    cwd: path.dirname(path.dirname(localCaptureScript())),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MODE: 'local' },
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  child.on('error', async (e) => {
    await db.updateCapture(job.id, { status: 'failed', error: `failed to start capture process: ${e.message}`, updatedAt: nowIso() });
  });
  child.on('exit', async (code, signal) => {
    const current = await db.getCapture(job.id);
    if (!current || current.status !== 'queued') return; // completion callback already ran
    if (code === 0) return;
    await db.updateCapture(job.id, {
      status: 'failed',
      error: `capture process exited with ${signal || code}: ${logs.slice(-500)}`,
      updatedAt: nowIso(),
    });
  });
  // watchdog: never leave a job stuck in queued/running forever
  const watchdog = setTimeout(async () => {
    const current = await db.getCapture(job.id);
    if (current && (current.status === 'queued' || current.status === 'running')) {
      await db.updateCapture(job.id, { status: 'failed', error: 'capture timed out (180s)', updatedAt: nowIso() });
      try { child.kill(); } catch { /* already gone */ }
    }
  }, Number(process.env.CAPTURE_TIMEOUT_MS || 180000));
  watchdog.unref();
  return child;
}
