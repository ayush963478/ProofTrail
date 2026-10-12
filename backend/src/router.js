// Tiny path router with CORS, error envelope, request id and rate limiting
// (docs/API.md: CORS + rate limiting sections).

import { AppError, toAppError } from './errors.js';
import { ALLOW_HEADERS, ALLOW_METHODS, corsOrigin, errorResponse, respond, requestId, parseJsonBody } from './http.js';
import { requireAuth } from './auth.js';
import { loadConfig } from './config.js';

/** Match `/evidence/:id/download` style patterns. Returns params or null. */
export function matchPath(pattern, path) {
  const p = pattern.split('/').filter(Boolean);
  const u = path.split('/').filter((q) => q !== '');
  if (p.length !== u.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      params[p[i].slice(1)] = decodeURIComponent(u[i]);
    } else if (p[i] !== u[i]) {
      return null;
    }
  }
  return params;
}

// --- in-memory sliding-window rate limiter (per IP) -------------------------
const buckets = new Map(); // ip -> [timestampMs, ...]

export function rateLimit(ip, limit, windowMs = 60000, now = Date.now()) {
  let list = buckets.get(ip);
  if (!list) {
    list = [];
    buckets.set(ip, list);
  }
  const cutoff = now - windowMs;
  // drop expired entries
  let start = 0;
  while (start < list.length && list[start] <= cutoff) start++;
  if (start > 0) list.splice(0, start);
  if (list.length >= limit) return false;
  list.push(now);
  if (buckets.size > 10000) {
    // hard prune to keep memory bounded
    for (const [k, v] of buckets) {
      if (v.length === 0 || v[v.length - 1] <= cutoff) buckets.delete(k);
    }
  }
  return true;
}

export function resetRateLimiter() {
  buckets.clear();
}

/** True for the routes that belong to the 60/min public bucket. */
function isPublicRoute(route) {
  if (route.rate) return route.rate === 'public';
  return route.path.startsWith('/public') ||
    route.path === '/meta' ||
    route.path.startsWith('/dev/') ||
    route.path.startsWith('/internal/');
}

function withCors(res, origin, extra = {}) {
  const headers = { ...extra, ...res.headers };
  if (origin) headers['access-control-allow-origin'] = origin;
  headers['access-control-allow-headers'] = ALLOW_HEADERS;
  headers['access-control-allow-methods'] = ALLOW_METHODS;
  headers['access-control-max-age'] = '86400';
  headers.vary = 'Origin';
  return { ...res, headers };
}

/**
 * Handle one request against a route table.
 *
 * ctx: { method, path, query, headers (lowercased keys), raw (Buffer), ip }
 * res: { status, headers, body }
 */
export async function handle(ctx, routes, cfg = loadConfig()) {
  ctx.requestId = ctx.requestId || requestId();
  const origin = corsOrigin(ctx.headers.origin, cfg.corsOrigins);
  const baseHeaders = { 'x-request-id': ctx.requestId };

  try {
    // --- preflight ---
    if (ctx.method === 'OPTIONS') {
      return withCors(respond(204, null), origin, baseHeaders);
    }

    // --- match ---
    let matched = null;
    let params = null;
    for (const route of routes) {
      if (route.method !== ctx.method) continue;
      const m = matchPath(route.path, ctx.path);
      if (m) {
        matched = route;
        params = m;
        break;
      }
    }
    if (!matched) throw new AppError('not_found', `No route for ${ctx.method} ${ctx.path}`);
    ctx.params = params;
    ctx.route = matched;

    // --- rate limit (sliding window per IP) ---
    const isPublic = isPublicRoute(matched);
    const limit = isPublic ? cfg.rateLimitPublic : cfg.rateLimitAuthed;
    if (!rateLimit(ctx.ip || 'unknown', limit)) {
      throw new AppError('rate_limited', `Rate limit exceeded (${limit} req/min). Retry later.`);
    }

    // --- body parsing: JSON in, raw kept for binary routes ---
    const contentType = String(ctx.headers['content-type'] || '');
    if (Buffer.isBuffer(ctx.raw) && contentType.includes('application/json')) {
      ctx.body = parseJsonBody(ctx.raw, { optional: matched.bodyOptional !== false });
    } else if (Buffer.isBuffer(ctx.raw)) {
      ctx.body = ctx.raw;
    } else {
      ctx.body = ctx.body ?? {};
    }

    // --- auth ---
    if (matched.auth) {
      await requireAuth(ctx, cfg);
    }

    const res = await matched.handler(ctx);
    return withCors(res || respond(204, null), origin, baseHeaders);
  } catch (err) {
    const appErr = toAppError(err);
    if (!(appErr instanceof AppError) || !appErr.expose) {
      // internal_error: log, do not leak internals
      console.error(`[error] ${ctx.method} ${ctx.path} -> ${appErr.code}:`, err && err.stack ? err.stack : err);
      const safe = new AppError('internal_error', 'Internal server error');
      return withCors(errorResponse(safe), origin, baseHeaders);
    }
    if (appErr.code === 'internal_error') {
      console.error(`[error] ${ctx.method} ${ctx.path}:`, err && err.stack ? err.stack : err);
    }
    return withCors(errorResponse(appErr), origin, baseHeaders);
  }
}

/** Build a router function bound to a route table. */
export function createRouter(routes, cfg = loadConfig()) {
  return (ctx) => handle(ctx, routes, cfg);
}
