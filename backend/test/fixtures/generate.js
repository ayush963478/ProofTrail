// RFC 3161 fixture generator — creates the committed TSA test fixtures using
// OpenSSL (3.x) plus this repo's own request encoder.
//
// Regeneration (from backend/):
//   node test/fixtures/generate.js
//
// Produces, in this directory:
//   tsa.key.pem  — test TSA private key (RSA 2048, TEST KEY, never for production)
//   tsa.crt      — self-signed TSA certificate (extendedKeyUsage = timeStamping)
//   message.bin  — the fixed message that gets timestamped
//   req.tsq      — TimeStampReq built with src/crypto/rfc3161.js (fixed nonce)
//   resp.tsr     — TimeStampResp signed by openssl ts -reply
//
// The test suite parses resp.tsr, checks the imprint/nonce/genTime and verifies
// the CMS signer signature against tsa.crt.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildTimeStampReq } from '../../src/crypto/rfc3161.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Fixed inputs so `req.tsq` is byte-for-byte reproducible. */
export const FIXTURE_MESSAGE = Buffer.from(
  'ProofTrail RFC 3161 fixture test message — deterministic regeneration.\n',
  'utf8',
);
export const FIXTURE_NONCE = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');

function openssl(args) {
  return execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: DIR });
}

/** Minimal OpenSSL config so `ts -reply` does not look for ./demoCA. */
function writeOpenSslConf() {
  const conf = [
    '[ default ]',
    'tsa_policy     = 1.2.3.4.1',
    'default_bits   = 2048',
    '',
    '[ tsa ]',
    'default_bits   = 2048',
    'digest         = sha256',
    'prompt         = no',
    'certificate    = tsa.crt',
    'private_key    = tsa.key.pem',
    'new_certs_dir  = .',
    'certs          = tsa.crt',
    'policy         = 1.2.3.4.1',
    'default_policy = 1.2.3.4.1',
    'digests        = sha256',
    'serial         = file:./tsa.serial',
    'default_days   = 365',
    'signer_digest  = sha256',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(DIR, 'openssl-tsa.cnf'), conf);
  return path.join(DIR, 'openssl-tsa.cnf');
}

export function generate() {
  const keyPath = path.join(DIR, 'tsa.key.pem');
  const crtPath = path.join(DIR, 'tsa.crt');
  const msgPath = path.join(DIR, 'message.bin');
  const reqPath = path.join(DIR, 'req.tsq');
  const respPath = path.join(DIR, 'resp.tsr');

  // 1. self-signed TSA cert with extendedKeyUsage = timeStamping
  if (!fs.existsSync(keyPath) || !fs.existsSync(crtPath)) {
    openssl([
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', crtPath,
      '-sha256', '-days', '3650',
      '-subj', '/CN=ProofTrail Test TSA/O=ProofTrail/OU=Tests/C=ZZ',
      '-addext', 'extendedKeyUsage=critical,timeStamping',
      '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=critical,digitalSignature',
    ]);
  }

  // 2. fixed message + request built with OUR encoder (fixed nonce)
  fs.writeFileSync(msgPath, FIXTURE_MESSAGE);
  const hashedMessage = crypto.createHash('sha256').update(FIXTURE_MESSAGE).digest();
  const req = buildTimeStampReq({ hashedMessage, nonce: FIXTURE_NONCE, certReq: true });
  fs.writeFileSync(reqPath, req);

  // 3. response signed by OpenSSL's TS responder emulation
  //    (OpenSSL 3.x: `-queryfile` reads the request; `-in` would read a response)
  const conf = writeOpenSslConf();
  // `ts -reply` reads the signing serial from the [tsa] section.
  fs.writeFileSync(path.join(DIR, 'tsa.serial'), '01\n');
  openssl(['ts', '-reply', '-config', conf, '-section', 'tsa',
    '-queryfile', reqPath, '-signer', crtPath, '-inkey', keyPath, '-out', respPath]);

  return { keyPath, crtPath, msgPath, reqPath, respPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = generate();
  for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(10)} ${v}`);
  console.log('fixtures regenerated.');
}
