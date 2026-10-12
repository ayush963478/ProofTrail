#!/usr/bin/env node
// One-command local dev for ProofTrail.
//
//   npm run dev        (from the repository root)
//
// Starts the backend (node, port 4000) and the frontend (vite, port 5173)
// together with interleaved, colour-prefixed logs. Ctrl+C stops both.
// If a backend is already running, this script keeps the frontend going
// against it instead of starting a duplicate.
//
// Requirements: Node 20+, dependencies installed once (npm run setup).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const COLORS = { backend: '\x1b[36m', frontend: '\x1b[35m' }; // cyan | magenta
const RESET = '\x1b[0m';

/** @type {{ name: string, child: import('node:child_process').ChildProcess }[]} */
const children = [];
let shuttingDown = false;

function say(name, line, isError = false) {
  const out = isError ? process.stderr : process.stdout;
  out.write(`${COLORS[name] || ''}[${name}]${RESET} ${line}\n`);
}

function onChildExit(name, code, signal) {
  if (shuttingDown) return;
  say(name, `exited (code=${code ?? '?'}${signal ? `, signal=${signal}` : ''})`, code !== 0);
  if (name === 'backend') {
    if (code === 0) {
      // start() decided a backend is already running — keep the frontend.
      say('backend', 'an existing backend is serving the API — reusing it.');
      return;
    }
    say('backend', 'backend failed — stopping the frontend too.', true);
    stopAll().then(() => process.exit(code || 1));
    return;
  }
  stopAll().then(() => process.exit(code || 0));
}

function run(name, args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push({ name, child });
  for (const [stream, isErr] of [
    [child.stdout, false],
    [child.stderr, true],
  ]) {
    readline.createInterface({ input: stream }).on('line', (l) => say(name, l, isErr));
  }
  child.on('exit', (code, signal) => onChildExit(name, code, signal));
  child.on('error', (err) => say(name, `failed to spawn: ${err.message}`, true));
  return child;
}

async function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all(
    children.map(({ child }) => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        const done = resolve;
        child.once('exit', done);
        if (isWin) {
          // Kill the whole tree so vite's esbuild child does not linger.
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          killer.on('error', done);
          killer.on('exit', done);
        } else {
          child.kill('SIGTERM');
        }
        setTimeout(done, 2000); // never hang forever
      });
    })
  );
}

/** True when a ProofTrail frontend already serves `port` (the vite dev index).
 *  Vite may bind only ::1 or only 127.0.0.1 depending on the host, so probe both. */
async function webAlreadyRunning(port, { timeoutMs = 700 } = {}) {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
      const html = await res.text();
      if (html.includes('ProofTrail')) return true;
    } catch {
      // nothing listening on this address — try the next
    }
  }
  return false;
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopAll().then(() => process.exit(0));
  });
}

// --- preflight ---------------------------------------------------------------

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(nodeMajor) || nodeMajor < 20) {
  console.error(`Node 20+ is required (found ${process.versions.node}).`);
  process.exit(1);
}

const backendEntry = path.join(ROOT, 'backend', 'src', 'local-server.js');
const viteEntry = path.join(ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js');
const missing = [];
if (!fs.existsSync(backendEntry)) missing.push('backend/src/local-server.js');
if (!fs.existsSync(viteEntry)) missing.push('frontend/node_modules (vite)');
if (missing.length > 0) {
  console.error(`Missing: ${missing.join(', ')}.\nRun "npm run setup" first (or npm install inside backend/ and frontend/).`);
  process.exit(1);
}

process.stdout.write(
  [
    '',
    '  ProofTrail dev',
    '  backend   → http://localhost:4000   (API — docs/API.md)',
    '  frontend  → http://localhost:5173   (Ctrl+C stops both)',
    '',
    ''
  ].join('\n')
);

run('backend', [backendEntry], path.join(ROOT, 'backend'));

if (await webAlreadyRunning(5173)) {
  say('frontend', 'a ProofTrail frontend is already serving http://localhost:5173 — not starting a second one.');
} else {
  run('frontend', [viteEntry], path.join(ROOT, 'frontend'));
}
