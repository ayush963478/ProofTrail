// ProofTrail backend configuration.
//
// One config object for both runtime profiles (aws | local). Every value is read
// from the environment; sensible local defaults are applied when the AWS
// variables are absent so `npm run dev` works with zero configuration.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  try {
    const v = JSON.parse(raw);
    return v;
  } catch {
    throw new Error(`Environment variable ${name} must be valid JSON, got: ${raw}`);
  }
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
  return n;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

const AWS_INDICATORS = ['MAIN_TABLE', 'LEDGER_TABLE', 'ANCHOR_TABLE', 'STAGING_BUCKET', 'VAULT_BUCKET'];

/**
 * Minimal .env loader (no dependency): reads backend/.env when present.
 * Existing process.env values always win, so shell/AWS/Lambda envs and the
 * test bootstrap stay authoritative. Supports KEY=value, optional `export`,
 * single/double quotes and `#` comments.
 */
function loadDotEnv() {
  const file = path.join(BACKEND_ROOT, '.env');
  if (!fs.existsSync(file)) return;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.split(' #')[0].trim();
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function detectMode() {
  const raw = (process.env.MODE || '').toLowerCase();
  if (raw === 'aws' || raw === 'local') return raw;
  // ARCHITECTURE.md: "local if unset and no AWS table/bucket envs present"
  return AWS_INDICATORS.some((k) => Boolean(process.env[k])) ? 'aws' : 'local';
}

let cached = null;

/** Build (or return the cached) configuration object. Reads process.env. */
export function loadConfig() {
  if (cached) return cached;
  loadDotEnv();

  const mode = detectMode();
  const authMode = (process.env.AUTH_MODE || (mode === 'aws' ? 'cognito' : 'dev')).toLowerCase() === 'cognito' ? 'cognito' : 'dev';
  const tsaMode = (process.env.TSA_MODE || (mode === 'aws' ? 'rfc3161' : 'local')).toLowerCase() === 'rfc3161' ? 'rfc3161' : 'local';
  const port = intEnv('PORT', 4000);

  const dataDirRaw = process.env.DATA_DIR && process.env.DATA_DIR !== '' ? process.env.DATA_DIR : path.join(BACKEND_ROOT, '.data');
  const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.resolve(BACKEND_ROOT, dataDirRaw);

  const cfg = {
    mode,                      // 'aws' | 'local'
    authMode,                  // 'cognito' | 'dev'
    tsaMode,                   // 'rfc3161' | 'local'
    port,

    // --- auth ---
    devJwtSecret: process.env.DEV_JWT_SECRET || 'prooftrail-dev-secret-change-me',
    cognito: {
      userPoolId: process.env.COGNITO_USER_POOL_ID || '',
      clientId: process.env.COGNITO_CLIENT_ID || '',
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    },

    // --- public links / CORS ---
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:5173').replace(/\/+$/, ''),
    apiBaseUrl: process.env.API_BASE_URL || `http://localhost:${port}`,
    // Local dev origins: vite bumps to the next free port when 5173 is busy
    // and the app is also reachable via 127.0.0.1 — allow the common set so a
    // restarted frontend never breaks on CORS. Override with CORS_ORIGINS.
    corsOrigins: parseJsonEnv('CORS_ORIGINS', [
      'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', 'http://localhost:5176',
      'http://127.0.0.1:5173', 'http://127.0.0.1:5174', 'http://127.0.0.1:5175', 'http://127.0.0.1:5176',
    ]),

    // --- storage ---
    dataDir,
    stagingDir: path.join(dataDir, 'staging'),
    vaultDir: path.join(dataDir, 'vault'),
    keysDir: path.join(dataDir, 'keys'),
    tablesDir: path.join(dataDir, 'tables'),
    anchorsDir: path.join(dataDir, 'anchors'),
    captureDir: path.join(dataDir, 'capture'),
    mainTable: process.env.MAIN_TABLE || 'prooftrail-main',
    ledgerTable: process.env.LEDGER_TABLE || 'prooftrail-ledger',
    anchorTable: process.env.ANCHOR_TABLE || 'prooftrail-anchor',
    auditTable: process.env.AUDIT_TABLE || 'prooftrail-audit',
    captureTable: process.env.CAPTURE_TABLE || 'prooftrail-capture',
    stagingBucket: process.env.STAGING_BUCKET || '',
    vaultBucket: process.env.VAULT_BUCKET || '',
    vaultRetentionDays: intEnv('VAULT_RETENTION_DAYS', 2555),

    // --- signing keys ---
    kmsKeyId: process.env.KMS_KEY_ID || 'alias/prooftrail-signing',
    activeSigningKey: process.env.ACTIVE_SIGNING_KEY || '', // overrides default key id

    // --- timestamping ---
    tsaUrl: process.env.TSA_URL || 'https://freetsa.org/tsr',
    tsaCertUrl: process.env.TSA_CERT_URL || '',
    tsaTimeoutMs: intEnv('TSA_TIMEOUT_MS', 15000),
    tsaRetries: intEnv('TSA_RETRIES', 2),

    // --- queues / capture ---
    sqsSealQueueUrl: process.env.SQS_SEAL_QUEUE_URL || '',
    captureCluster: process.env.CAPTURE_CLUSTER || '',
    captureTaskDef: process.env.CAPTURE_TASK_DEF || '',
    captureSubnets: (process.env.CAPTURE_SUBNETS || '').split(',').map((s) => s.trim()).filter(Boolean),
    captureSecurityGroups: (process.env.CAPTURE_SG || '').split(',').map((s) => s.trim()).filter(Boolean),
    serviceToken: process.env.SERVICE_TOKEN || 'local-service-token',

    // --- anchoring ---
    anchorExternalUrl: process.env.ANCHOR_EXTERNAL_URL || '',
    anchorBatchCap: intEnv('ANCHOR_BATCH_CAP', 500),
    anchorIntervalMs: intEnv('ANCHOR_INTERVAL_MS', 15 * 60 * 1000),

    // --- audit / limits ---
    auditSalt: process.env.AUDIT_SALT || 'prooftrail-audit-salt',
    auditTtlDays: intEnv('AUDIT_TTL_DAYS', 365),
    maxBodyBytes: intEnv('MAX_BODY_BYTES', 100 * 1024 * 1024),
    maxEvidenceSize: intEnv('MAX_EVIDENCE_SIZE', 100 * 1024 * 1024),
    rateLimitPublic: intEnv('RATE_LIMIT_PUBLIC', 60),
    rateLimitAuthed: intEnv('RATE_LIMIT_AUTHED', 300),
    nodeEnv: process.env.NODE_ENV || 'development',
  };

  // Ensure local storage directories exist.
  if (cfg.mode === 'local') {
    for (const dir of [cfg.dataDir, cfg.stagingDir, cfg.vaultDir, cfg.keysDir, cfg.tablesDir, cfg.anchorsDir, cfg.captureDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  cached = cfg;
  return cfg;
}

/** Test helper: forget the cached config so a new DATA_DIR takes effect. */
export function resetConfig() {
  cached = null;
}

/** The active signing key id (KMS key ARN/alias in aws mode, local_<n> in local mode). */
export function activeKeyId(cfg) {
  if (cfg.activeSigningKey) return cfg.activeSigningKey;
  return cfg.mode === 'aws' ? cfg.kmsKeyId : 'local_1';
}
