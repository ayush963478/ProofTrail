// Staging + write-once vault (docs/ARCHITECTURE.md "Storage").
//
// aws   — S3 staging (presigned PUT for clients); seal copies staging → vault
//         with IfNoneMatch:* against the Object Lock bucket, then deletes the
//         staged object.
// local — $DATA_DIR/staging and $DATA_DIR/vault with the same key layout;
//         commit refuses to overwrite an existing path (app-level Object Lock).

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';

export function stagingKey(evidenceId) {
  return `uploads/${evidenceId}`;
}

export function vaultKeyFor(evidenceId, filename, dateIso = new Date()) {
  const iso = dateIso instanceof Date ? dateIso.toISOString() : String(dateIso);
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `vault/${y}/${m}/${d}/${evidenceId}/${filename}`;
}

function localPath(root, key) {
  const p = path.resolve(root, ...String(key).split('/'));
  const base = path.resolve(root);
  if (p !== base && !p.startsWith(base + path.sep)) {
    throw new AppError('validation_error', 'storage key escapes root');
  }
  return p;
}

let s3 = null;
async function ensureS3(cfg) {
  if (!s3) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const region = cfg.cognito?.region || process.env.AWS_REGION || 'us-east-1';
    s3 = new S3Client({ region });
  }
  return s3;
}

async function s3send(command, cfg) {
  const c = await ensureS3(cfg);
  return c.send(command);
}

function stagingRoot(cfg) {
  return cfg.stagingDir || path.join(cfg.dataDir, 'staging');
}
function vaultRoot(cfg) {
  return cfg.vaultDir || path.join(cfg.dataDir, 'vault');
}

/** Write bytes to staging (server-side path used by local mode and captures). */
export async function putStaging(key, buffer, cfg = loadConfig()) {
  if (cfg.mode === 'aws') {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await s3send(new PutObjectCommand({ Bucket: cfg.stagingBucket, Key: key, Body: buffer }), cfg);
    return key;
  }
  const p = localPath(stagingRoot(cfg), key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buffer);
  return key;
}

export async function getStaging(key, cfg = loadConfig()) {
  if (cfg.mode === 'aws') {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const out = await s3send(new GetObjectCommand({ Bucket: cfg.stagingBucket, Key: key }), cfg);
    return Buffer.from(await out.Body.transformToByteArray());
  }
  const p = localPath(stagingRoot(cfg), key);
  if (!fs.existsSync(p)) throw new AppError('not_found', 'staged upload not found');
  return fs.readFileSync(p);
}

export async function stagingExists(key, cfg = loadConfig()) {
  if (cfg.mode === 'aws') {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      await s3send(new HeadObjectCommand({ Bucket: cfg.stagingBucket, Key: key }), cfg);
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(localPath(stagingRoot(cfg), key));
}

export async function deleteStaging(key, cfg = loadConfig()) {
  if (cfg.mode === 'aws') {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await s3send(new DeleteObjectCommand({ Bucket: cfg.stagingBucket, Key: key }), cfg).catch(() => null);
    return;
  }
  const p = localPath(stagingRoot(cfg), key);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** Presigned PUT for the client (aws mode). Local mode uses the proxied upload route. */
export async function presignStagingPut(key, metadata = {}, cfg = loadConfig()) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = await ensureS3(cfg);
  const command = new PutObjectCommand({
    Bucket: cfg.stagingBucket,
    Key: key,
    Metadata: metadata,
  });
  return getSignedUrl(client, command, { expiresIn: 900 });
}

/**
 * Move a staged object into the write-once vault.
 * Local: refuse to overwrite (app-level Object Lock).
 */
export async function commitToVault({ stagingKey: sk, vaultKey: vk }, cfg = loadConfig()) {
  if (cfg.mode === 'aws') {
    const { CopyObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      await s3send(
        new CopyObjectCommand({
          Bucket: cfg.vaultBucket,
          Key: vk,
          CopySource: `${cfg.stagingBucket}/${sk.split('/').map(encodeURIComponent).join('/')}`,
          IfNoneMatch: '*',
          MetadataDirective: 'COPY',
        }),
        cfg
      );
    } catch (err) {
      if (err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412) {
        throw new AppError('conflict', 'Vault object already exists (write-once)');
      }
      throw err;
    }
    await deleteStaging(sk, cfg);
    return vk;
  }
  const src = localPath(stagingRoot(cfg), sk);
  const dst = localPath(vaultRoot(cfg), vk);
  if (fs.existsSync(dst)) throw new AppError('conflict', 'Vault object already exists (write-once)');
  if (!fs.existsSync(src)) throw new AppError('not_found', 'staged upload not found');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  fs.unlinkSync(src);
  return vk;
}

export async function getVault(key, cfg = loadConfig()) {
  if (cfg.mode === 'aws') {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const out = await s3send(new GetObjectCommand({ Bucket: cfg.vaultBucket, Key: key }), cfg);
    return Buffer.from(await out.Body.transformToByteArray());
  }
  const p = localPath(vaultRoot(cfg), key);
  if (!fs.existsSync(p)) throw new AppError('not_found', 'vault object not found');
  return fs.readFileSync(p);
}

export async function vaultExists(key, cfg = loadConfig()) {
  if (cfg.mode === 'aws') {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      await s3send(new HeadObjectCommand({ Bucket: cfg.vaultBucket, Key: key }), cfg);
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(localPath(vaultRoot(cfg), key));
}

/**
 * Write derived artifacts (e.g. package zips) into the vault exactly once.
 * Same write-once semantics as commitToVault but without a staging step.
 */
export async function putVaultBytesOnce(key, buffer, cfg = loadConfig()) {
  if (cfg.mode === 'aws') {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      await s3send(
        new PutObjectCommand({ Bucket: cfg.vaultBucket, Key: key, Body: buffer, IfNoneMatch: '*' }),
        cfg
      );
    } catch (err) {
      if (err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412) {
        throw new AppError('conflict', 'Vault object already exists (write-once)');
      }
      throw err;
    }
    return key;
  }
  const p = localPath(vaultRoot(cfg), key);
  if (fs.existsSync(p)) throw new AppError('conflict', 'Vault object already exists (write-once)');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buffer);
  return key;
}

// --- aliases used by services/{evidence,seal,capture,package}.js ------------

export const stagingKeyFor = stagingKey;
export const putStagingBytes = putStaging;
export const getStagingBytes = getStaging;
export const getVaultBytes = getVault;

export async function presignUpload(key, metadata = {}, cfg = loadConfig()) {
  return presignStagingPut(key, metadata, cfg);
}

export async function sealMove(stagingKeyValue, vaultKeyValue, cfg = loadConfig()) {
  return commitToVault({ stagingKey: stagingKeyValue, vaultKey: vaultKeyValue }, cfg);
}
