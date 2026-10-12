// Router contract (docs/API.md): path matching, error envelope, CORS,
// rate limiting, dev-token auth flow, /meta tiers, 404 for unknown routes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { matchPath, handle, rateLimit, resetRateLimiter } from '../src/router.js';
import { routes as apiRoutes } from '../src/handlers/api.js';
import { routes as publicRoutes } from '../src/handlers/public.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
const ROUTES = [...publicRoutes, ...apiRoutes];
const ORIGIN = 'http://localhost:5173';

/** Router ctx factory (matches local-server.js / normalizeEvent output). */
function ctx(over = {}) {
  return {
    method: 'GET',
    path: '/',
    query: {},
    headers: {},
    raw: Buffer.alloc(0),
    ip: '10.0.0.1',
    ...over,
  };
}
const jsonCtx = (method, path, body, headers = {}) => ctx({
  method,
  path,
  headers: { 'content-type': 'application/json', ...headers },
  raw: Buffer.from(JSON.stringify(body), 'utf8'),
});

// --- matchPath --------------------------------------------------------------

test('matchPath matches literals and captures :params', () => {
  assert.deepEqual(matchPath('/cases/:caseId', '/cases/case_abc'), { caseId: 'case_abc' });
  assert.deepEqual(
    matchPath('/evidence/:id/download', '/evidence/ev_1/download'),
    { id: 'ev_1' },
  );
  assert.deepEqual(
    matchPath('/public/verify/:token', '/public/verify/abc%2Fdef'),
    { token: 'abc/def' },
    'params are URI-decoded',
  );
  assert.equal(matchPath('/cases/:caseId', '/cases/a/b'), null, 'segment count differs');
  assert.equal(matchPath('/cases/:caseId', '/evidence/x'), null, 'literal differs');
  assert.equal(matchPath('/meta', '/meta/x'), null, 'extra segment');
  assert.deepEqual(matchPath('/meta', '/meta'), {}, 'literal-only pattern');
});

// --- error envelope ---------------------------------------------------------

test('unknown route returns the 404 error envelope', async () => {
  const res = await handle(ctx({ path: '/does/not/exist', ip: '10.0.0.2' }), ROUTES, cfg);
  assert.equal(res.status, 404);
  assert.deepEqual(Object.keys(res.body), ['error']);
  assert.equal(res.body.error.code, 'not_found');
  assert.equal(typeof res.body.error.message, 'string');
  assert.ok(res.headers['x-request-id'], 'request id header set');
});

test('validation errors use the envelope with the documented status', async () => {
  const res = await handle(
    jsonCtx('POST', '/dev/token', { email: 'not-an-email' }, { origin: ORIGIN }),
    ROUTES,
    cfg,
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_error');
  assert.equal(typeof res.body.error.message, 'string');
});

test('an authed route without a token is 401 unauthorized', async () => {
  const res = await handle(ctx({ path: '/me', ip: '10.0.0.3' }), ROUTES, cfg);
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthorized');
});

// --- CORS -------------------------------------------------------------------

test('CORS preflight returns 204 with allow headers/methods', async () => {
  const res = await handle(ctx({ method: 'OPTIONS', path: '/cases', headers: { origin: ORIGIN }, ip: '10.0.0.4' }), ROUTES, cfg);
  assert.equal(res.status, 204);
  assert.equal(res.body, null);
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
  assert.match(res.headers['access-control-allow-headers'], /Authorization/);
  assert.match(res.headers['access-control-allow-methods'], /GET/);
  assert.equal(res.headers.vary, 'Origin');
});

test('CORS is echoed for an allowed origin and omitted otherwise', async () => {
  const ok = await handle(ctx({ path: '/meta', headers: { origin: ORIGIN }, ip: '10.0.0.5' }), ROUTES, cfg);
  assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);

  const bad = await handle(ctx({ path: '/meta', headers: { origin: 'https://evil.test' }, ip: '10.0.0.6' }), ROUTES, cfg);
  assert.equal(bad.status, 200, 'request still served');
  assert.equal(bad.headers['access-control-allow-origin'], undefined, 'origin not allowed');
});

// --- rate limiting ----------------------------------------------------------

test('rateLimit enforces a sliding window and recovers after it passes', () => {
  resetRateLimiter();
  const ip = '198.51.100.1';
  const t0 = 1_000_000;
  assert.equal(rateLimit(ip, 2, 60000, t0), true);
  assert.equal(rateLimit(ip, 2, 60000, t0 + 1000), true);
  assert.equal(rateLimit(ip, 2, 60000, t0 + 2000), false, 'third hit in-window denied');
  assert.equal(rateLimit(ip, 2, 60000, t0 + 61000), true, 'oldest entries expire');
  assert.equal(rateLimit('198.51.100.2', 2, 60000, t0 + 2000), true, 'other IPs unaffected');
  resetRateLimiter();
});

test('a request over the public limit returns 429 rate_limited', async () => {
  const limited = { ...cfg, rateLimitPublic: 3 };
  const ip = '198.51.100.3';
  for (let i = 0; i < 3; i++) {
    const res = await handle(ctx({ path: '/meta', ip }), ROUTES, limited);
    assert.equal(res.status, 200, `hit ${i + 1} allowed`);
  }
  const res = await handle(ctx({ path: '/meta', ip }), ROUTES, limited);
  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, 'rate_limited');
  assert.match(res.body.error.message, /Rate limit/);
  // a different IP is not affected by the exhausted bucket
  const other = await handle(ctx({ path: '/meta', ip: '198.51.100.4' }), ROUTES, limited);
  assert.equal(other.status, 200);
  resetRateLimiter();
});

// --- dev token auth flow ----------------------------------------------------

test('POST /dev/token mints a token that unlocks GET /me', async () => {
  const issued = await handle(
    jsonCtx('POST', '/dev/token', { email: 'Router.User@example.com', name: 'Router User' }, { origin: ORIGIN }),
    ROUTES,
    cfg,
  );
  assert.equal(issued.status, 200);
  assert.equal(typeof issued.body.token, 'string');
  assert.equal(issued.body.expiresIn, 86400);
  assert.equal(issued.body.user.id, 'usr_router_user_example_com');
  assert.equal(issued.body.user.email, 'Router.User@example.com');
  assert.equal(issued.body.user.plan, 'free');

  const me = await handle(
    ctx({ path: '/me', headers: { authorization: `Bearer ${issued.body.token}`, origin: ORIGIN }, ip: '10.0.0.7' }),
    ROUTES,
    cfg,
  );
  assert.equal(me.status, 200);
  assert.equal(me.body.id, 'usr_router_user_example_com');
  assert.equal(me.body.email, 'Router.User@example.com');
  assert.equal(me.body.name, 'Router User');

  const tampered = await handle(
    ctx({ path: '/me', headers: { authorization: `Bearer ${issued.body.token}x`, origin: ORIGIN }, ip: '10.0.0.8' }),
    ROUTES,
    cfg,
  );
  assert.equal(tampered.status, 401);
  assert.equal(tampered.body.error.code, 'unauthorized');
});

test('dev tokens are refused when AUTH_MODE is not dev (route absent -> 404)', async () => {
  // public.js only registers /dev/token in dev mode; in cognito mode the
  // route table has no entry, so the request falls through to the 404.
  const cognitoRoutes = publicRoutes.filter((r) => r.path !== '/dev/token');
  const res = await handle(jsonCtx('POST', '/dev/token', { email: 'a@b.co' }), cognitoRoutes, cfg);
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found');
});

// --- /meta ------------------------------------------------------------------

test('GET /meta exposes app identity, mode and the blueprint §9 tiers', async () => {
  const res = await handle(ctx({ path: '/meta', ip: '10.0.0.9' }), ROUTES, cfg);
  assert.equal(res.status, 200);
  assert.equal(res.body.appName, 'ProofTrail');
  assert.equal(res.body.authMode, 'dev');
  assert.equal(res.body.mode, 'local');

  const tiers = res.body.tiers;
  assert.ok(Array.isArray(tiers) && tiers.length === 4);
  assert.deepEqual(tiers.map((t) => t.id), ['free', 'personal', 'pro', 'enterprise']);
  for (const t of tiers) {
    for (const k of ['id', 'name', 'audience', 'offer']) {
      assert.equal(typeof t[k], 'string', `tier.${k} is a string`);
      assert.ok(t[k].length > 0, `tier.${k} is non-empty`);
    }
  }
});
