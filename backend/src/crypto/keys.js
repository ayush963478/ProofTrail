// Signing key abstraction (docs/ARCHITECTURE.md "Keys").
//
// aws   — KMS asymmetric key: Sign (MessageType RAW, ECDSA_SHA_256) +
//         GetPublicKey -> SPKI PEM. keyId = key ARN/alias at seal time.
// local — EC P-256 keypair PEM files in .data/keys/<keyId>.{key.pem,pub.pem},
//         auto-generated on first use (keyId "local_1").

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, activeKeyId } from '../config.js';
import { AppError } from '../errors.js';
import { derToSpkiPem } from './signature.js';

const ALGORITHM = 'ECDSA_SHA_256';

let kmsClient = null;
async function getKms(cfg) {
  if (!kmsClient) {
    const { KMSClient } = await import('@aws-sdk/client-kms');
    kmsClient = new KMSClient({ region: cfg.cognito.region || process.env.AWS_REGION });
  }
  return kmsClient;
}

// --- local PEM files --------------------------------------------------------

function keyPaths(cfg, keyId) {
  if (!/^[\w.-]+$/.test(keyId)) throw new AppError('validation_error', `Invalid keyId: ${keyId}`);
  return {
    priv: path.join(cfg.keysDir, `${keyId}.key.pem`),
    pub: path.join(cfg.keysDir, `${keyId}.pub.pem`),
  };
}

function generateLocalKey(cfg, keyId) {
  const { priv, pub } = keyPaths(cfg, keyId);
  fs.mkdirSync(cfg.keysDir, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
  });
  // 'wx' -> first writer wins; a concurrent generator just re-reads.
  try {
    fs.writeFileSync(priv, privateKey, { flag: 'wx' });
    fs.writeFileSync(pub, publicKey, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return { priv, pub };
}

function ensureLocalKey(cfg, keyId) {
  const { priv, pub } = keyPaths(cfg, keyId);
  if (!fs.existsSync(priv)) generateLocalKey(cfg, keyId);
  if (!fs.existsSync(pub)) {
    const privPem = fs.readFileSync(priv, 'utf8');
    const spki = crypto.createPublicKey(privPem).export({ type: 'spki', format: 'pem' });
    try {
      fs.writeFileSync(pub, spki, { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  return { priv, pub };
}

// --- public API -------------------------------------------------------------

/** Sign raw bytes. Returns { keyId, algorithm, value } (value = base64 DER). */
export async function signBytes(data, cfg = loadConfig(), keyId = activeKeyId(cfg)) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (cfg.mode === 'aws') {
    const kms = await getKms(cfg);
    const { SignCommand } = await import('@aws-sdk/client-kms');
    const out = await kms.send(new SignCommand({
      KeyId: keyId,
      Message: bytes,
      MessageType: 'RAW',
      SigningAlgorithm: ALGORITHM,
    }));
    return { keyId, algorithm: ALGORITHM, value: out.Signature.toString('base64') };
  }
  const { priv } = ensureLocalKey(cfg, keyId);
  const privPem = fs.readFileSync(priv, 'utf8');
  const sig = crypto.sign('sha256', bytes, { key: privPem, dsaEncoding: 'der' });
  return { keyId, algorithm: ALGORITHM, value: sig.toString('base64') };
}

/** Resolve a public key: { keyId, algorithm, publicKeyPem, source: 'kms'|'local' }. */
export async function getPublicKey(keyId, cfg = loadConfig()) {
  if (!keyId) throw new AppError('not_found', 'keyId required');
  if (cfg.mode === 'aws') {
    const kms = await getKms(cfg);
    const { GetPublicKeyCommand } = await import('@aws-sdk/client-kms');
    try {
      const out = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
      const pem = derToSpkiPem(Buffer.from(out.PublicKey));
      return { keyId, algorithm: ALGORITHM, publicKeyPem: pem, source: 'kms' };
    } catch (e) {
      if (e.name === 'NotFoundException' || e.name === 'InvalidArnException' || e.name === 'NotFoundException') {
        throw new AppError('not_found', `Unknown signing key: ${keyId}`);
      }
      throw e;
    }
  }
  // local
  if (!/^[\w.-]+$/.test(keyId)) throw new AppError('not_found', `Unknown signing key: ${keyId}`);
  const { pub, priv } = keyPaths(cfg, keyId);
  if (!fs.existsSync(priv)) throw new AppError('not_found', `Unknown signing key: ${keyId}`);
  ensureLocalKey(cfg, keyId);
  const pem = fs.readFileSync(pub, 'utf8');
  return { keyId, algorithm: ALGORITHM, publicKeyPem: pem, source: 'local' };
}

/** Reset the cached KMS client (tests). */
export function _resetKmsClient() {
  kmsClient = null;
}
