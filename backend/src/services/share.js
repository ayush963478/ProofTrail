// Share links (docs/API.md Share shape): create / validate / revoke, expiry
// checks, scopes evidence|package.

import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { getDb } from './db.js';

export const SHARE_SCOPES = ['evidence', 'package'];

/** 43-char base64url token (32 random bytes). */
export function newShareToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Create a share.
 * @param {{scope, targetId, includeDownload?, expiresInHours?}} opts
 */
export async function createShare({ scope, targetId, includeDownload = true, expiresInHours }, cfg = loadConfig(), db = getDb(cfg)) {
  if (!SHARE_SCOPES.includes(scope)) throw new AppError('validation_error', `scope must be one of ${SHARE_SCOPES.join('|')}`);
  if (!targetId) throw new AppError('validation_error', 'targetId is required');
  if (expiresInHours !== undefined && expiresInHours !== null) {
    const h = Number(expiresInHours);
    if (!Number.isFinite(h) || h <= 0) throw new AppError('validation_error', 'expiresInHours must be a positive number');
  }
  const now = new Date();
  const share = {
    id: `shr_${crypto.randomBytes(8).toString('hex')}`,
    token: newShareToken(),
    scope,
    targetId,
    includeDownload: includeDownload !== false,
    expiresAt: expiresInHours === undefined || expiresInHours === null
      ? null
      : new Date(now.getTime() + Number(expiresInHours) * 3600 * 1000).toISOString(),
    revokedAt: null,
    createdAt: now.toISOString(),
  };
  return db.putShare(share);
}

/**
 * Validate a share token for access.
 * @throws 404 unknown / 410 revoked or expired
 */
export async function validateShare(token, cfg = loadConfig(), db = getDb(cfg)) {
  if (!token || typeof token !== 'string') throw new AppError('not_found', 'Unknown share token');
  const share = await db.getShareByToken(token);
  if (!share) throw new AppError('not_found', 'Unknown share token');
  if (share.revokedAt) throw new AppError('gone', 'This share link has been revoked');
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) {
    throw new AppError('gone', 'This share link has expired');
  }
  return share;
}

/** Revoke a share (404 when unknown). */
export async function revokeShare(shareId, cfg = loadConfig(), db = getDb(cfg)) {
  const share = await db.getShareById(shareId);
  if (!share) throw new AppError('not_found', 'Share not found');
  if (share.revokedAt) return share;
  return db.updateShare(shareId, { revokedAt: new Date().toISOString() });
}

export async function listShares(targetId, cfg = loadConfig(), db = getDb(cfg)) {
  return db.listSharesByTarget(targetId);
}

/** Verification URL for a token (API.md: {PUBLIC_BASE_URL}/verify/{token}). */
export function verificationUrl(token, cfg = loadConfig()) {
  return `${cfg.publicBaseUrl}/verify/${token}`;
}
