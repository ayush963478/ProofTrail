// Shared test bootstrap.
//
// IMPORTANT: this module must be imported BEFORE any `src/` module so the
// environment below is in place the first time loadConfig() runs (config is
// cached per process; node --test runs each *.test.js in its own process).
//
// Every test file gets an isolated DATA_DIR under backend/.data/ so suites
// never share ledger/vault state, and the tree is removed on process exit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '..');
export const FIXTURES = path.join(here, 'fixtures');

const tag = path.basename(process.argv[1] || 'test').replace(/\.m?js$/, '');
export const DATA_DIR = path.join(BACKEND_ROOT, '.data', `test-${tag}-${process.pid}`);

process.env.MODE = 'local';
process.env.AUTH_MODE = 'dev';
process.env.TSA_MODE = 'local';
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';
process.env.PUBLIC_BASE_URL = 'http://localhost:5173';
process.env.SERVICE_TOKEN = 'test-service-token';
process.env.DEV_JWT_SECRET = 'test-dev-secret';
delete process.env.MAIN_TABLE;
delete process.env.LEDGER_TABLE;
delete process.env.ANCHOR_TABLE;
delete process.env.STAGING_BUCKET;
delete process.env.VAULT_BUCKET;

fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

process.on('exit', () => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Standard test actor (dev JWT `sub`). */
export const ACTOR = { sub: 'usr_test_owner', email: 'owner@example.com', name: 'Test Owner' };
export const OTHER = { sub: 'usr_test_other', email: 'other@example.com', name: 'Other User' };
