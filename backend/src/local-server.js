// Local development server: node:http → router ctx → handle() → response.
// Same handlers, router, auth and rate limits as the Lambda deployment.

import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { handle } from './router.js';
import { routes as apiRoutes } from './handlers/api.js';
import { routes as publicRoutes } from './handlers/public.js';

const MAX_BODY = () => loadConfig().maxBodyBytes || 100 * 1024 * 1024;

function isPublicPath(p) {
  return p === '/meta' || p.startsWith('/public') || p.startsWith('/dev/') || p.startsWith('/internal');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY()) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serialize(res) {
  const headers = { ...(res.headers || {}) };
  let body = res.body;
  if (body === null || body === undefined || res.status === 204) {
    body = '';
  } else if (Buffer.isBuffer(body)) {
    // binary: keep Buffer
  } else if (typeof body !== 'string') {
    body = JSON.stringify(body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json; charset=utf-8';
    }
  } else if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'text/plain; charset=utf-8';
  }
  return { status: res.status || 200, headers, body };
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const raw = await readBody(req);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      }
      const ctx = {
        method: req.method || 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        raw,
        ip: (req.socket.remoteAddress || '0.0.0.0').replace(/^::ffff:/, ''),
      };
      const routes = isPublicPath(ctx.path) ? publicRoutes : apiRoutes;
      const out = serialize(await handle(ctx, routes));
      res.writeHead(out.status, out.headers);
      res.end(Buffer.isBuffer(out.body) ? out.body : String(out.body));
    } catch (err) {
      console.error('[error]', err);
      if (!res.headersSent) {
        // readBody() rejects with { status: 413 } when the body exceeds
        // MAX_BODY_BYTES — API.md maps that to payload_too_large.
        const status = Number(err && err.status) || 500;
        const code = status === 413 ? 'payload_too_large' : 'internal_error';
        const message = status === 413 ? 'Request body exceeds MAX_BODY_BYTES' : 'Internal server error';
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code, message } }));
      } else {
        res.end();
      }
    }
  });
}

/**
 * What is listening on `port`?
 *   'free'       → nothing
 *   'prooftrail' → a ProofTrail backend already answers GET /meta there
 *   'busy'       → some other application owns the port
 * Used so `npm run dev` / F5 can be run repeatedly without starting a second
 * backend against the same .data directory or moving to a port the frontend
 * does not know about.
 */
export async function portStatus(port, { timeoutMs = 700 } = {}) {
  const reachable = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
  if (!reachable) return 'free';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/meta`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    if (body && body.appName === 'ProofTrail') return 'prooftrail';
  } catch {
    // some other HTTP(S) server — fall through
  }
  return 'busy';
}

export async function start() {
  const cfg = loadConfig();

  // Port already taken? Never start a second instance against the same .data
  // directory, and never silently move to another port (the frontend calls a
  // fixed URL from frontend/.env) — behave clearly instead.
  const status = await portStatus(cfg.port);
  if (status === 'prooftrail') {
    const say = (m) => console.log(`[prooftrail] ${m}`);
    say(`ProofTrail backend is already running at http://localhost:${cfg.port} — not starting a second instance.`);
    say('Use the running one, or stop it (Ctrl+C in its terminal) and start again.');
    return null;
  }
  if (status === 'busy') {
    throw new Error(
      `port ${cfg.port} is used by another application. Stop that program, or ` +
      `start with PORT=<free port> and point frontend/.env VITE_API_BASE_URL at it.`
    );
  }

  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, resolve);
    });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      throw new Error(`port ${cfg.port} was taken while starting — try again.`);
    }
    throw err;
  }

  const line = (m) => console.log(`[prooftrail] ${m}`);
  line(`ProofTrail backend listening on http://localhost:${cfg.port}`);
  line(`mode=${cfg.mode} auth=${cfg.authMode} tsa=${cfg.tsaMode} data=${cfg.dataDir}`);
  line(`verification base url: ${cfg.publicBaseUrl}`);
  line(`public routes : GET /meta, /public/verify/:token, /public/keys/:keyId`);
  line(`auth routes   : ${cfg.authMode === 'dev' ? 'POST /dev/token' : 'Cognito JWT (Authorization: Bearer)'}`);
  line(`app routes    : /cases /evidence /captures /packages ... (docs/API.md)`);
  if (cfg.mode === 'local' && cfg.anchorIntervalMs > 0) {
    const timer = setInterval(() => {
      import('./services/anchor.js')
        .then((m) => m.anchorNow())
        .then((r) => line(`anchor batch: ${JSON.stringify(r)}`))
        .catch((e) => line(`anchor batch failed: ${e.message}`));
    }, cfg.anchorIntervalMs);
    timer.unref();
  }
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start()
    .then((server) => {
      if (server === null) process.exit(0); // already running elsewhere
    })
    .catch((err) => {
      console.error(`[prooftrail] failed to start: ${err.message}`);
      process.exit(1);
    });
}
