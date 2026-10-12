// JWT authentication (docs/API.md "Auth").
//
// cognito mode — RS256 verification against the User Pool JWKS (jose handles
//   JWKS fetching + caching). The API Gateway Cognito authorizer also fronts
//   the API in AWS, but the backend verifies the token itself.
// dev mode — HS256 with DEV_JWT_SECRET, minted by POST /dev/token.
//
// Actor identity = JWT claim `sub`.

import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { AppError } from './errors.js';
import { loadConfig } from './config.js';

const DEV_ISSUER = 'prooftrail-dev';

let jwksCache = new Map(); // per pool URL

function jwksFor(cfg) {
  const url = `https://cognito-idp.${cfg.cognito.region}.amazonaws.com/${cfg.cognito.userPoolId}/.well-known/jwks.json`;
  if (!jwksCache.has(url)) {
    jwksCache.set(url, createRemoteJWKSet(new URL(url), { cooldownDuration: 300000, cacheMaxAge: 600000 }));
  }
  return jwksCache.get(url);
}

/** usr_<slug> from an email address (stable per email). */
export function devSubFromEmail(email) {
  const slug = String(email).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `usr_${slug || 'anonymous'}`;
}

/** Mint a dev token (HS256). Only valid when AUTH_MODE=dev. */
export async function issueDevToken({ email, name }, cfg = loadConfig()) {
  if (cfg.authMode !== 'dev') {
    throw new AppError('forbidden', 'Dev tokens are only available when AUTH_MODE=dev');
  }
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new AppError('validation_error', 'email is required and must be a valid address');
  }
  const sub = devSubFromEmail(email);
  const secret = new TextEncoder().encode(cfg.devJwtSecret);
  const expiresIn = 86400;
  const token = await new SignJWT({ email: email.trim(), name: name || email.trim().split('@')[0] })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuer(DEV_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
    .sign(secret);
  const user = {
    id: sub,
    email: email.trim(),
    name: name || email.trim().split('@')[0],
    plan: 'free',
    mfaEnabled: false,
  };
  return { token, expiresIn, user };
}

/** Verify a bearer token. Returns claims. Throws AppError(401) on failure. */
export async function verifyToken(token, cfg = loadConfig()) {
  try {
    if (cfg.authMode === 'dev') {
      const secret = new TextEncoder().encode(cfg.devJwtSecret);
      const { payload } = await jwtVerify(token, secret, { issuer: DEV_ISSUER, algorithms: ['HS256'] });
      return payload;
    }
    if (!cfg.cognito.userPoolId) {
      throw new AppError('unauthorized', 'Cognito is not configured (COGNITO_USER_POOL_ID missing)');
    }
    const issuer = `https://cognito-idp.${cfg.cognito.region}.amazonaws.com/${cfg.cognito.userPoolId}`;
    const { payload } = await jwtVerify(token, jwksFor(cfg), {
      issuer,
      algorithms: ['RS256'],
      ...(cfg.cognito.clientId ? { audience: cfg.cognito.clientId } : {}),
    });
    return payload;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('unauthorized', 'Invalid or expired token');
  }
}

/** Extract `Authorization: Bearer <jwt>` (case-insensitive). */
export function bearerFromHeaders(headers) {
  const raw = headers['authorization'] || headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : null;
}

/**
 * requireAuth middleware. Sets ctx.actor = { sub, email, name, claims } and
 * returns it, or throws AppError(401).
 */
export async function requireAuth(ctx, cfg = loadConfig()) {
  if (ctx.actor) return ctx.actor;
  const token = bearerFromHeaders(ctx.headers);
  if (!token) throw new AppError('unauthorized', 'Missing Authorization: Bearer <token>');
  const claims = await verifyToken(token, cfg);
  if (!claims.sub) throw new AppError('unauthorized', 'Token has no sub claim');
  ctx.actor = {
    sub: String(claims.sub),
    email: claims.email ? String(claims.email) : null,
    name: claims.name ? String(claims.name) : null,
    claims,
  };
  return ctx.actor;
}
