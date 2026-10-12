// TSA client wrapper (docs/ARCHITECTURE.md "Timestamp").
//
// rfc3161 mode — real RFC 3161 client (crypto/rfc3161.js) against cfg.tsaUrl
//                (default https://freetsa.org/tsr) with timeout + retries and
//                optional trusted-certificate check (TSA_CERT_URL).
// local mode   — clearly-flagged dev timestamp { mode: "local" } signed by a
//                local EC P-256 dev key. Never presented as trusted time.
//
// Result shape: { mode, tsa, token (base64), genTime }
// plus verify(result, { expectedHash }) -> { ok, genTime, ... } (throws on failure).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { AppError } from '../errors.js';
import { sha256Bytes } from '../crypto/hash.js';
import {
  buildTimeStampReq,
  requestTimestamp,
  verifyTimestampResponse,
} from '../crypto/rfc3161.js';

const LOCAL_TOKEN_VERSION = 1;

// --- local dev key ----------------------------------------------------------

function localTsaKeyPaths(cfg) {
  return {
    priv: path.join(cfg.keysDir, 'local_tsa.key.pem'),
    pub: path.join(cfg.keysDir, 'local_tsa.pub.pem'),
  };
}

function ensureLocalTsaKey(cfg) {
  const { priv, pub } = localTsaKeyPaths(cfg);
  fs.mkdirSync(cfg.keysDir, { recursive: true });
  if (!fs.existsSync(priv)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'sec1', format: 'pem' },
    });
    try {
      fs.writeFileSync(priv, privateKey, { flag: 'wx' });
      fs.writeFileSync(pub, publicKey, { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  if (!fs.existsSync(pub)) {
    try {
      fs.writeFileSync(pub, crypto.createPublicKey(fs.readFileSync(priv, 'utf8')).export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  return { priv, pub };
}

// --- rfc3161 ----------------------------------------------------------------

let trustedCertCache = { url: null, pem: null, fetchedAt: 0 };

async function trustedTsaCert(cfg) {
  if (!cfg.tsaCertUrl) return null;
  const now = Date.now();
  if (trustedCertCache.url === cfg.tsaCertUrl && now - trustedCertCache.fetchedAt < 3600000) {
    return trustedCertCache.pem;
  }
  try {
    const res = await fetch(cfg.tsaCertUrl, { signal: AbortSignal.timeout(cfg.tsaTimeoutMs) });
    if (!res.ok) throw new Error(`TSA cert responded ${res.status}`);
    const pem = await res.text();
    if (!pem.includes('BEGIN CERTIFICATE')) throw new Error('TSA cert URL did not return a PEM certificate');
    trustedCertCache = { url: cfg.tsaCertUrl, pem, fetchedAt: now };
    return pem;
  } catch (e) {
    // Unavailable trusted-cert check must not brick sealing; log and continue
    // (the token signature itself is still verified against the cert in-token).
    console.warn(`[timestamp] TSA_CERT_URL fetch failed (${e.message}); continuing with in-token certificate`);
    trustedCertCache = { url: cfg.tsaCertUrl, pem: null, fetchedAt: now };
    return null;
  }
}

async function rfc3161Timestamp(bytes, cfg) {
  const hashedMessage = sha256Bytes(bytes);
  const nonce = crypto.randomBytes(16);
  const req = buildTimeStampReq({ hashedMessage, nonce });
  const trusted = await trustedTsaCert(cfg);
  const resp = await requestTimestamp(req, {
    url: cfg.tsaUrl,
    timeoutMs: cfg.tsaTimeoutMs,
    retries: cfg.tsaRetries,
  });
  const verified = verifyTimestampResponse(resp, {
    expectedHash: hashedMessage,
    expectedNonce: nonce,
    trustedCert: trusted,
  });
  return {
    mode: 'rfc3161',
    tsa: cfg.tsaUrl,
    token: resp.toString('base64'),
    genTime: verified.genTime,
    policy: verified.policy,
  };
}

// --- local (dev) ------------------------------------------------------------

function localTimestamp(bytes, cfg) {
  const { priv, pub } = ensureLocalTsaKey(cfg);
  const imprint = sha256Bytes(bytes).toString('hex');
  const genTime = new Date().toISOString();
  const payload = `${LOCAL_TOKEN_VERSION}|${imprint}|${genTime}`;
  const sig = crypto.sign('sha256', Buffer.from(payload, 'utf8'), {
    key: fs.readFileSync(priv, 'utf8'),
    dsaEncoding: 'der',
  });
  const tokenObj = {
    v: LOCAL_TOKEN_VERSION,
    mode: 'local',
    imprint,
    genTime,
    sig: sig.toString('base64'),
    spki: fs.readFileSync(pub, 'utf8'),
  };
  return {
    mode: 'local',
    tsa: null,
    token: Buffer.from(JSON.stringify(tokenObj), 'utf8').toString('base64'),
    genTime,
  };
}

// --- public API -------------------------------------------------------------

/** Timestamp `bytes` (the exact message the imprint must cover). */
export async function createTimestamp(bytes, cfg = loadConfig()) {
  if (cfg.tsaMode === 'rfc3161') {
    try {
      return await rfc3161Timestamp(bytes, cfg);
    } catch (e) {
      if (cfg.mode === 'aws') throw e;
      // local profile: fall back to the flagged dev timestamp (ARCHITECTURE.md)
      console.warn(`[timestamp] RFC3161 TSA failed (${e.message}); falling back to TSA_MODE=local dev timestamp`);
      return localTimestamp(bytes, cfg);
    }
  }
  return localTimestamp(bytes, cfg);
}

/**
 * Verify a stored timestamp result.
 * @param {{mode, tsa, token, genTime}} ts
 * @param {{expectedHash: Buffer|string}} opts expected imprint (bytes or hex)
 * @returns {{ok: true, mode, genTime, tsa, detail}}
 * @throws {AppError} on any failure
 */
export function verifyTimestamp(ts, { expectedHash } = {}) {
  if (!ts || typeof ts !== 'object' || !ts.token) {
    throw new AppError('validation_error', 'timestamp missing');
  }
  const want = expectedHash
    ? Buffer.isBuffer(expectedHash) ? expectedHash : Buffer.from(String(expectedHash), 'hex')
    : null;

  if (ts.mode === 'rfc3161') {
    const resp = Buffer.from(ts.token, 'base64');
    const v = verifyTimestampResponse(resp, want ? { expectedHash: want } : {});
    if (ts.genTime && ts.genTime !== v.genTime) {
      throw new AppError('validation_error', `timestamp genTime mismatch: proof=${ts.genTime} token=${v.genTime}`);
    }
    return { ok: true, mode: 'rfc3161', genTime: v.genTime, tsa: ts.tsa, policy: v.policy, detail: `RFC 3161 token from ${ts.tsa || 'TSA'} verified` };
  }

  if (ts.mode === 'local') {
    let obj;
    try {
      obj = JSON.parse(Buffer.from(ts.token, 'base64').toString('utf8'));
    } catch {
      throw new AppError('validation_error', 'local timestamp token is not valid');
    }
    if (obj.mode !== 'local' || obj.v !== LOCAL_TOKEN_VERSION) {
      throw new AppError('validation_error', 'local timestamp token version mismatch');
    }
    const payload = `${obj.v}|${obj.imprint}|${obj.genTime}`;
    const ok = crypto.verify(
      'sha256',
      Buffer.from(payload, 'utf8'),
      { key: obj.spki, dsaEncoding: 'der' },
      Buffer.from(obj.sig, 'base64'),
    );
    if (!ok) throw new AppError('validation_error', 'local timestamp signature verification failed');
    if (want && want.toString('hex') !== obj.imprint) {
      throw new AppError('validation_error', 'local timestamp imprint mismatch');
    }
    if (ts.genTime && ts.genTime !== obj.genTime) {
      throw new AppError('validation_error', 'local timestamp genTime mismatch');
    }
    return {
      ok: true,
      mode: 'local',
      genTime: obj.genTime,
      tsa: null,
      detail: 'DEV timestamp (TSA_MODE=local) — flagged as local, not a trusted third-party TSA',
    };
  }

  throw new AppError('validation_error', `Unknown timestamp mode: ${ts.mode}`);
}
