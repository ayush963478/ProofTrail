// HTTP helpers shared by the local server and the Lambda adapters.

import { AppError } from './errors.js';

export const ALLOW_HEADERS =
  'Authorization,Content-Type,x-client-sha256,x-service-token,x-amz-meta-client-sha256,x-amz-meta-evidence-id';
export const ALLOW_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';

/** Build a response object. body: object (JSON) | string | Buffer (binary) | null */
export function respond(status, body, headers = {}) {
  return { status, headers, body };
}

export const json = (status, body, headers = {}) => respond(status, body, headers);

export const binary = (status, buffer, contentType, headers = {}) =>
  respond(status, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), {
    'content-type': contentType || 'application/octet-stream',
    ...headers,
  });

export const noContent = (headers = {}) => respond(204, null, headers);

/** Error envelope per API.md. */
export function errorResponse(err) {
  const code = err instanceof AppError ? err.code : 'internal_error';
  const status = err instanceof AppError ? err.status : 500;
  const message = err instanceof AppError ? err.message : 'Internal server error';
  return respond(status, { error: { code, message } });
}

export function requestId() {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Parse a JSON body. Empty body -> fallback ({} by default). */
export function parseJsonBody(raw, { optional = true } = {}) {
  if (!raw || raw.length === 0) {
    if (optional) return {};
    throw new AppError('validation_error', 'Request body is required');
  }
  let text;
  try {
    text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  } catch {
    throw new AppError('validation_error', 'Request body could not be decoded as UTF-8');
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('validation_error', 'Request body must be a JSON object');
    }
    return parsed;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('validation_error', 'Request body is not valid JSON');
  }
}

/** RFC 6266 Content-Disposition with UTF-8 fallback. */
export function contentDisposition(filename) {
  const safe = String(filename || 'download').replace(/[\r\n"\\]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Pick the response origin per API.md CORS rules. */
export function corsOrigin(origin, allowed) {
  if (!origin) return null;
  if (Array.isArray(allowed) && allowed.includes('*')) return '*';
  if (Array.isArray(allowed) && allowed.includes(origin)) return origin;
  return null;
}

export function isBinaryBody(body) {
  return Buffer.isBuffer(body);
}

/** Convert a router response into an API Gateway HTTP API (payload v2) result. */
export function toLambdaResult(res) {
  const headers = { ...(res.headers || {}) };
  let body = res.body;
  let isBase64Encoded = false;

  if (body === null || body === undefined || res.status === 204) {
    body = '';
  } else if (Buffer.isBuffer(body)) {
    isBase64Encoded = true;
    body = body.toString('base64');
  } else if (typeof body !== 'string') {
    body = JSON.stringify(body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json; charset=utf-8';
    }
  } else if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'text/plain; charset=utf-8';
  }

  return { statusCode: res.status, headers, body, isBase64Encoded };
}
