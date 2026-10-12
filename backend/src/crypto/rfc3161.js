/**
 * Zero-dependency RFC 3161 time-stamping client and verifier.
 *
 *  - createTimeStampRequest(message): DER TimeStampReq over sha256(message)
 *  - parseTimeStampResponse(buf):      status + CMS token extraction
 *  - verifyTimestamp({message, token}): imprint / genTime / signature / chain
 *
 * The timestamped message is always the canonical manifest bytes, so
 * messageImprint.hashedMessage === manifestHash (see docs/API.md).
 */
import crypto from 'node:crypto';
import { sha256Bytes } from './hash.js';
import { AppError } from '../errors.js';

// ---------- OIDs ----------
export const OID = {
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  sha1: '1.3.14.3.2.26',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  messageDigest: '1.2.840.113549.1.9.4',
};

const HASH_BY_OID = {
  [OID.sha256]: 'sha256',
  [OID.sha384]: 'sha384',
  [OID.sha512]: 'sha512',
  [OID.sha1]: 'sha1',
};

// ---------- DER encode ----------
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  if (n < 0x10000) return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
  if (n < 0x1000000) return Buffer.from([0x83, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  throw new Error('DER length too large');
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

export function derSeq(content) {
  return tlv(0x30, Buffer.isBuffer(content) ? content : Buffer.concat(content));
}

function derSet(content) {
  return tlv(0x31, Buffer.isBuffer(content) ? content : Buffer.concat(content));
}

function derIntPositive(buf) {
  let b = Buffer.from(buf);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function base128(n) {
  const chunks = [];
  let num = n;
  do {
    chunks.push(num % 128);
    num = Math.floor(num / 128);
  } while (num > 0);
  // chunks are least-significant first; the continuation bit belongs on every
  // byte except the final (least significant) one, which is chunks[0].
  for (let i = 1; i < chunks.length; i++) chunks[i] |= 0x80;
  return Buffer.from(chunks.reverse());
}

export function derOid(oid) {
  const parts = oid.split('.').map(Number);
  const head = Buffer.from([40 * parts[0] + parts[1]]);
  const rest = Buffer.concat(parts.slice(2).map(base128));
  return tlv(0x06, Buffer.concat([head, rest]));
}

function decodeOid(buf) {
  if (buf.length === 0) return '';
  const first = buf[0];
  const a = first >= 80 ? 2 : Math.floor(first / 40);
  const arcs = [a, first - 40 * a];
  let num = 0;
  for (let i = 1; i < buf.length; i++) {
    num = num * 128 + (buf[i] & 0x7f);
    if (!(buf[i] & 0x80)) {
      arcs.push(num);
      num = 0;
    }
  }
  return arcs.join('.');
}

function algId(oid) {
  return derSeq(derOid(oid)); // absent parameters
}

// ---------- DER decode ----------
function readTlv(buf, offset = 0) {
  if (offset + 2 > buf.length) throw new Error('DER: truncated TLV');
  const tag = buf[offset];
  let len = buf[offset + 1];
  let pos = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || pos + n > buf.length) throw new Error('DER: bad length');
    len = 0;
    for (let i = 0; i < n; i++) {
      len = len * 256 + buf[pos];
      pos++;
    }
  }
  if (pos + len > buf.length) throw new Error('DER: content exceeds buffer');
  return { tag, content: buf.subarray(pos, pos + len), end: pos + len, raw: buf.subarray(offset, pos + len) };
}

function readAll(buf) {
  const items = [];
  let off = 0;
  while (off < buf.length) {
    const t = readTlv(buf, off);
    items.push(t);
    off = t.end;
  }
  return items;
}

function intToBuf(content) {
  let i = 0;
  while (i < content.length - 1 && content[i] === 0) i++;
  return content.subarray(i);
}

// ---------- request ----------
export function createTimeStampRequest(message) {
  const digest = sha256Bytes(message);
  const nonce = crypto.randomBytes(8);
  const messageImprint = derSeq([algId(OID.sha256), tlv(0x04, digest)]);
  const request = derSeq([
    tlv(0x02, Buffer.from([0x01])), // version v1
    messageImprint,
    derIntPositive(nonce),
    tlv(0x01, Buffer.from([0xff])), // certReq TRUE
  ]);
  return { request, digest, nonce };
}

// ---------- response ----------
export function parseTimeStampResponse(buf) {
  const outer = readTlv(buf, 0);
  if (outer.tag !== 0x30) throw new Error('TimeStampResp: expected SEQUENCE');
  const items = readAll(outer.content);
  const statusInfo = items[0];
  if (!statusInfo || statusInfo.tag !== 0x30) throw new Error('TimeStampResp: missing PKIStatusInfo');
  const si = readAll(statusInfo.content);
  if (!si[0] || si[0].tag !== 0x02) throw new Error('TimeStampResp: missing status');
  const status = Number(intToBuf(si[0].content).readUInt8(0));
  let statusString = '';
  for (const item of si.slice(1)) {
    if (item.tag === 0xa0) {
      for (const inner of readAll(item.content)) {
        if (inner.tag === 0x0c || inner.tag === 0x16) statusString += inner.content.toString('utf8');
      }
    }
  }
  if (status !== 0 && status !== 1) {
    throw new Error(`TSA refused request (status ${status})${statusString ? ': ' + statusString : ''}`);
  }
  const tokenTlv = items[1];
  if (!tokenTlv) throw new Error('TimeStampResp: no token');
  return { status, statusString, tokenTlv };
}

function parseSignedData(tokenTlv) {
  const ci = readAll(tokenTlv.content);
  const contentType = ci[0];
  if (!contentType || contentType.tag !== 0x06 || decodeOid(contentType.content) !== OID.signedData) {
    throw new Error('token: not ContentInfo(signedData)');
  }
  if (!ci[1] || ci[1].tag !== 0xa0) throw new Error('token: missing signedData content');
  const sd = readTlv(ci[1].content, 0);
  if (sd.tag !== 0x30) throw new Error('token: signedData not a SEQUENCE');
  const sdItems = readAll(sd.content);

  let eContent = null;
  for (const item of readAll(sdItems[2].content)) {
    if (item.tag === 0xa0) {
      const inner = readTlv(item.content, 0);
      if (inner.tag === 0x04) eContent = inner.content;
      else if (inner.tag === 0x24) {
        eContent = Buffer.concat(readAll(inner.content).map((x) => x.content));
      }
    }
  }

  const certs = [];
  let signerInfosTlv = null;
  for (let i = 3; i < sdItems.length; i++) {
    if (sdItems[i].tag === 0xa0) {
      for (const c of readAll(sdItems[i].content)) if (c.tag === 0x30) certs.push(c.raw);
    } else if (sdItems[i].tag === 0x31) {
      signerInfosTlv = sdItems[i];
    }
  }
  if (!signerInfosTlv) throw new Error('token: no signerInfos');
  const signerInfo = readAll(signerInfosTlv.content)[0];
  if (!signerInfo || signerInfo.tag !== 0x30) throw new Error('token: bad signerInfo');

  const si = readAll(signerInfo.content);
  let idx = 2; // version, sid
  const sid = si[1];
  let serialHex = '';
  if (sid && sid.tag === 0x30) {
    const sidItems = readAll(sid.content);
    if (sidItems[1] && sidItems[1].tag === 0x02) serialHex = intToBuf(sidItems[1].content).toString('hex');
  }
  const digestAlgOid = si[idx] && si[idx].tag === 0x30 ? decodeOid(readAll(si[idx].content)[0].content) : OID.sha256;
  idx++;
  let signedAttrsContent = null;
  if (si[idx] && si[idx].tag === 0xa0) {
    signedAttrsContent = si[idx].content;
    idx++;
  }
  // signatureAlgorithm (skip), signature
  let signature = null;
  for (let i = idx; i < si.length; i++) {
    if (si[i].tag === 0x04) signature = si[i].content;
  }
  if (!signature) throw new Error('token: no signature');
  if (!eContent) throw new Error('token: no eContent (TSTInfo)');

  return { eContent, certs, serialHex, digestAlgOid, signedAttrsContent, signature };
}

export function parseTstInfo(buf) {
  // `buf` is the full DER TSTInfo; unwrap the outer SEQUENCE if present.
  const outer = readTlv(buf, 0);
  const items = outer.tag === 0x30 ? readAll(outer.content) : readAll(buf);
  const out = {
    version: null,
    policy: null,
    imprintOid: null,
    imprint: null,
    serial: null,
    nonce: null,
    genTime: null,
  };
  let i = 0;
  if (items[i] && items[i].tag === 0x02) {
    out.version = Number(intToBuf(items[i].content).readUInt8(0));
    i++;
  }
  if (items[i] && items[i].tag === 0x06) {
    out.policy = decodeOid(items[i].content);
    i++;
  }
  if (items[i] && items[i].tag === 0x30) {
    const mi = readAll(items[i].content);
    out.imprintOid = decodeOid(readAll(mi[0].content)[0].content);
    out.imprint = mi[1].content;
    i++;
  }
  if (items[i] && items[i].tag === 0x02) {
    out.serial = intToBuf(items[i].content);
    i++;
  }
  if (items[i] && (items[i].tag === 0x18 || items[i].tag === 0x17)) {
    out.genTime = items[i].content.toString('ascii');
    i++;
  }
  // Optional tail: accuracy [30], ordering [01], nonce [02] or [1] EXPLICIT
  // [A1 → INTEGER] (real TSAs), tsa [0] EXPLICIT [A0], extensions [1] IMPLICIT
  // [A1 → SEQUENCE OF]. Disambiguate the two A1 shapes by their content.
  for (; i < items.length; i++) {
    const item = items[i];
    if (item.tag === 0x02) out.nonce = intToBuf(item.content);
    else if (item.tag === 0xa1) {
      const inner = readAll(item.content);
      if (inner.length === 1 && inner[0].tag === 0x02) out.nonce = intToBuf(inner[0].content);
    }
  }
  return out;
}

export function genTimeToIso(genTime) {
  if (!genTime) return null;
  const m = String(genTime).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
}

function normalizeSerial(hex) {
  let h = (hex || '').toUpperCase().replace(/^0+/, '');
  return h || '0';
}

function findSigner(certs, serialHex, signedAttrs, eContent, digestName, signature) {
  const data = signedAttrs ? derSet(signedAttrs) : eContent;
  const candidates = [];
  for (const der of certs) {
    try {
      const x = new crypto.X509Certificate(der);
      if (serialHex && normalizeSerial(x.serialNumber) === normalizeSerial(serialHex)) candidates.unshift(der);
      else candidates.push(der);
    } catch {
      /* skip unparsable cert */
    }
  }
  for (const der of candidates) {
    try {
      const x = new crypto.X509Certificate(der);
      if (crypto.verify(digestName, data, x.publicKey, signature)) return x;
    } catch {
      /* try next */
    }
  }
  return null;
}

function messageDigestAttrOk(signedAttrsContent, eContent, digestName) {
  if (!signedAttrsContent) return null;
  try {
    for (const attr of readAll(signedAttrsContent)) {
      if (attr.tag !== 0x30) continue;
      const parts = readAll(attr.content);
      if (parts[0] && parts[0].tag === 0x06 && decodeOid(parts[0].content) === OID.messageDigest) {
        const set = parts[1];
        const oct = readAll(set.content)[0];
        const expected = crypto.createHash(digestName).update(eContent).digest();
        return expected.equals(oct.content);
      }
    }
  } catch {
    return false;
  }
  return null;
}

function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

/**
 * Full verification of a timestamp token against the original message.
 * Returns { valid, checks, genTime, policy, signerSerial }.
 * `expectedNonce` is optional (only available right after issuing a request).
 */
export function verifyTimestamp({ message, token, tsaCertPem = null, expectedNonce = null }) {
  const checks = {};
  let tst = null;
  let parsed = null;
  try {
    const resp = parseTimeStampResponse(token);
    parsed = parseSignedData(resp.tokenTlv);
    tst = parseTstInfo(parsed.eContent);
  } catch (err) {
    return {
      valid: false,
      checks: { parse: { passed: false, detail: err.message } },
      genTime: null,
      policy: null,
      signerSerial: null,
    };
  }

  const digestName = HASH_BY_OID[parsed.digestAlgOid] || 'sha256';
  const digest = sha256Bytes(message);

  const imprintOk =
    tst.imprintOid === OID.sha256 && tst.imprint && digest.equals(tst.imprint);
  checks.imprint = {
    passed: imprintOk,
    detail: imprintOk
      ? 'message imprint matches sha256 of the signed manifest'
      : 'message imprint does not match the manifest hash',
  };

  const genIso = genTimeToIso(tst.genTime);
  checks.genTime = {
    passed: !!genIso,
    detail: genIso ? `TSA time: ${genIso}` : 'genTime missing or unparsable',
  };

  if (expectedNonce) {
    const a = Buffer.from(expectedNonce);
    const b = tst.nonce || Buffer.alloc(0);
    const ok = a.equals(b);
    checks.nonce = { passed: ok, detail: ok ? 'nonce matches request' : 'nonce mismatch' };
  }

  const digestOk = messageDigestAttrOk(parsed.signedAttrsContent, parsed.eContent, digestName);
  if (digestOk !== null) {
    checks.messageDigest = {
      passed: digestOk,
      detail: digestOk ? 'signed attribute messageDigest matches TSTInfo' : 'messageDigest mismatch',
    };
  }

  const signer = findSigner(
    parsed.certs,
    parsed.serialHex,
    parsed.signedAttrsContent,
    parsed.eContent,
    digestName,
    parsed.signature
  );
  checks.signature = {
    passed: !!signer,
    detail: signer ? 'CMS signature valid (TSA certificate)' : 'CMS signature verification failed',
  };

  let chainOk = true;
  let chainDetail = 'no TSA certificate configured to check against';
  if (tsaCertPem) {
    chainOk = false;
    chainDetail = 'signer is not the configured TSA certificate';
    if (signer) {
      try {
        const tsa = new crypto.X509Certificate(pemToDer(tsaCertPem));
        const sameSpki = signer.publicKey
          .export({ type: 'spki', format: 'der' })
          .equals(tsa.publicKey.export({ type: 'spki', format: 'der' }));
        const signedByTsa = signer.verify(tsa.publicKey);
        if (sameSpki) {
          chainOk = true;
          chainDetail = 'signer is the configured TSA certificate';
        } else if (signedByTsa) {
          chainOk = true;
          chainDetail = 'signer certificate issued by the configured TSA certificate';
        }
      } catch (err) {
        chainDetail = `chain check error: ${err.message}`;
      }
    }
  }
  checks.chain = { passed: chainOk, detail: chainDetail };

  // Every computed check must pass (nonce/messageDigest are only present when
  // relevant — a mismatched expected nonce or a bad signed attribute must
  // invalidate the token, not just annotate it).
  const required = ['imprint', 'genTime', 'signature', 'chain', 'nonce', 'messageDigest'];
  const valid = required.every((k) => !checks[k] || checks[k].passed);
  return {
    valid,
    checks,
    genTime: genIso,
    policy: tst.policy,
    signerSerial: parsed.serialHex || null,
  };
}

// ---------------------------------------------------------------------------
// Adapter API used by services/timestamp.js
// ---------------------------------------------------------------------------

/**
 * Build a DER TimeStampReq for a precomputed digest.
 * @param {{hashedMessage: Buffer, nonce: Buffer}} opts  sha256(message), random nonce
 * @returns {Buffer} DER-encoded request
 */
export function buildTimeStampReq({ hashedMessage, nonce }) {
  const messageImprint = derSeq([algId(OID.sha256), tlv(0x04, hashedMessage)]);
  return derSeq([
    tlv(0x02, Buffer.from([0x01])), // version v1
    messageImprint,
    derIntPositive(nonce),
    tlv(0x01, Buffer.from([0xff])), // certReq TRUE
  ]);
}

/**
 * POST a TimeStampReq to a TSA with timeout and retries.
 * @returns {Promise<Buffer>} raw TimeStampResp DER
 */
export async function requestTimestamp(request, { url, timeoutMs = 15000, retries = 2 } = {}) {
  if (!url) throw new Error('TSA url not configured');
  let lastErr = new Error('TSA request failed');
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/timestamp-query',
          accept: 'application/timestamp-reply',
        },
        body: request,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`TSA responded ${res.status}`);
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html') || ct.includes('application/json')) {
        throw new Error(`TSA returned an error page (content-type: ${ct})`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 32) throw new Error('TSA response too short to be a TimeStampResp');
      return buf;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Verify a raw TimeStampResp. Throws AppError('validation_error') on any
 * failed check; returns { genTime, policy, signerSerial, checks } on success.
 *
 * @param {Buffer} resp
 * @param {{expectedHash?: Buffer|string, expectedNonce?: Buffer, trustedCert?: string|null}} opts
 */
export function verifyTimestampResponse(resp, { expectedHash = null, expectedNonce = null, trustedCert = null } = {}) {
  const fail = (msg) => {
    throw new AppError('validation_error', `Timestamp verification failed: ${msg}`);
  };

  let parsed;
  let tst;
  try {
    const r = parseTimeStampResponse(resp);
    parsed = parseSignedData(r.tokenTlv);
    tst = parseTstInfo(parsed.eContent);
  } catch (err) {
    if (err instanceof AppError) throw err;
    fail(err.message);
  }

  if (expectedHash) {
    const want = Buffer.isBuffer(expectedHash) ? expectedHash : Buffer.from(String(expectedHash), 'hex');
    if (!tst.imprint || !want.equals(tst.imprint)) fail('message imprint does not match the expected hash');
  }
  if (expectedNonce) {
    if (!tst.nonce || !Buffer.from(expectedNonce).equals(tst.nonce)) fail('nonce mismatch (stale or replayed response)');
  }

  const genIso = genTimeToIso(tst.genTime);
  if (!genIso) fail('genTime missing or unparsable');

  const digestName = HASH_BY_OID[parsed.digestAlgOid] || 'sha256';

  const digestAttr = messageDigestAttrOk(parsed.signedAttrsContent, parsed.eContent, digestName);
  if (digestAttr === false) fail('signed messageDigest attribute does not match TSTInfo');

  const signer = findSigner(
    parsed.certs,
    parsed.serialHex,
    parsed.signedAttrsContent,
    parsed.eContent,
    digestName,
    parsed.signature
  );
  if (!signer) fail('CMS signature could not be verified');

  if (trustedCert) {
    let ok = false;
    try {
      const tsa = new crypto.X509Certificate(pemToDer(trustedCert));
      const sameSpki = signer.publicKey
        .export({ type: 'spki', format: 'der' })
        .equals(tsa.publicKey.export({ type: 'spki', format: 'der' }));
      ok = sameSpki || signer.verify(tsa.publicKey);
    } catch (err) {
      fail(`trusted TSA certificate check error: ${err.message}`);
    }
    if (!ok) fail('signer is not the configured trusted TSA certificate');
  }

  return {
    genTime: genIso,
    policy: tst.policy,
    signerSerial: parsed.serialHex || null,
    checks: {
      imprint: true,
      genTime: true,
      messageDigest: digestAttr !== false,
      signature: true,
      chain: !!trustedCert,
    },
  };
}

