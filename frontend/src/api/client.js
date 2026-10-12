// ProofTrail API client.
//
// Mirrors docs/API.md exactly: routes, methods, bodies, error envelope
// { error: { code, message } } -> thrown ApiError { code, message, status }.
//
// Auth: Authorization: Bearer <token> attached on every authenticated call.
// The token itself is provided by the AuthProvider via setTokenProvider().

import { env } from '../lib/env.js';

export const API_BASE = env.apiBaseUrl;

let tokenProvider = () => null;
let unauthorizedHandler = null;

/** AuthProvider registers a function returning the current JWT (or null). */
export function setTokenProvider(fn) {
  tokenProvider = typeof fn === 'function' ? fn : () => null;
}

/** AuthProvider registers a function called on any 401 of an authenticated call. */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = typeof fn === 'function' ? fn : null;
}

export class ApiError extends Error {
  constructor(message, { code = 'internal_error', status = 0, details = null } = {}) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Turn a route path (or absolute URL) into a fetchable URL. */
export function resolveUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return API_BASE + (path.startsWith('/') ? path : `/${path}`);
}

function sameOriginAsApi(url) {
  try {
    const target = new URL(url, window.location.href);
    const base = new URL(API_BASE, window.location.href);
    return target.origin === base.origin;
  } catch {
    return false;
  }
}

function authHeader() {
  const token = tokenProvider();
  return token ? `Bearer ${token}` : null;
}

async function errorFromResponse(res) {
  let code = 'internal_error';
  let message = `Request failed with status ${res.status}`;
  try {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) {
      const data = await res.json();
      if (data && data.error && data.error.code) {
        code = data.error.code;
        message = data.error.message || message;
      } else if (data && data.message) {
        message = data.message;
      }
    } else {
      const text = await res.text();
      if (text) message = text.slice(0, 300);
    }
  } catch {
    /* keep defaults */
  }
  return new ApiError(message, { code, status: res.status });
}

function networkError(path) {
  return new ApiError(
    `Cannot reach the ProofTrail API at ${API_BASE} (${path}). ` +
      'Is the backend running? Start it with "npm run dev" in the project root ' +
      '(or "npm run dev" inside backend/), then reload.',
    {
      code: 'network_error',
      status: 0,
    }
  );
}

function isAbort(e) {
  return e && (e.name === 'AbortError' || e.code === 20);
}

/** Core JSON request. Throws ApiError on non-2xx or network failure. */
export async function request(
  path,
  {
    method = 'GET',
    body,
    headers = {},
    auth = true,
    signal,
    timeout = 30000,
  } = {}
) {
  const url = resolveUrl(path);
  const h = { Accept: 'application/json', ...headers };
  let payload;

  if (body !== undefined && body !== null) {
    if (
      body instanceof Blob ||
      body instanceof ArrayBuffer ||
      body instanceof Uint8Array ||
      typeof body === 'string'
    ) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
    }
  }

  if (auth) {
    const bearer = authHeader();
    if (bearer) h.Authorization = bearer;
  }

  let ctrl = null;
  let timer = null;
  let effectiveSignal = signal || null;
  if (timeout && !signal) {
    ctrl = new AbortController();
    effectiveSignal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), timeout);
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: h,
      body: payload,
      signal: effectiveSignal,
      credentials: 'omit',
    });
  } catch (e) {
    if (isAbort(e)) {
      if (signal) throw e; // caller aborted on purpose
      throw new ApiError(`Timed out calling ${path}`, { code: 'timeout', status: 0 });
    }
    throw networkError(path);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    const err = await errorFromResponse(res);
    if (res.status === 401 && auth && unauthorizedHandler) unauthorizedHandler(err);
    throw err;
  }

  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  return await res.text();
}

/** Raw Response (used by downloads). Throws ApiError like request(). */
async function rawRequest(path, { method = 'GET', headers = {}, auth = true, signal } = {}) {
  const url = resolveUrl(path);
  const h = { ...headers };
  if (auth) {
    const bearer = authHeader();
    if (bearer) h.Authorization = bearer;
  }
  let res;
  try {
    res = await fetch(url, { method, headers: h, signal, credentials: 'omit' });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw networkError(path);
  }
  if (!res.ok) {
    const err = await errorFromResponse(res);
    if (res.status === 401 && auth && unauthorizedHandler) unauthorizedHandler(err);
    throw err;
  }
  return res;
}

function filenameFromDisposition(cd) {
  if (!cd) return null;
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : null;
}

function triggerBlobDownload(blob, name) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}

/**
 * Fetch a binary endpoint with auth and save it via a temporary anchor.
 * Honors Content-Disposition when no filename is given.
 */
export async function downloadBlob(path, { filename, auth = true, fallbackName = 'download' } = {}) {
  const res = await rawRequest(path, { auth });
  const blob = await res.blob();
  const name =
    filename || filenameFromDisposition(res.headers.get('content-disposition')) || fallbackName;
  triggerBlobDownload(blob, name);
  return name;
}

/**
 * Raw-byte upload (PUT). Used for the evidence upload step.
 * - `uploadHeaders` come from POST /evidence (x-amz-meta-* in aws mode,
 *   x-client-sha256 locally).
 * - Authorization is only attached when the target is our own API origin —
 *   S3 presigned PUT URLs must NOT carry a bearer token.
 */
export async function putRaw(
  url,
  body,
  uploadHeaders = {},
  { auth, signal, contentType } = {}
) {
  const target = resolveUrl(url);
  const useAuth = auth !== undefined ? auth : sameOriginAsApi(target);
  const h = { ...uploadHeaders };
  if (contentType && !h['Content-Type'] && !h['content-type']) h['Content-Type'] = contentType;
  if (useAuth) {
    const bearer = authHeader();
    if (bearer) h.Authorization = bearer;
  }
  let res;
  try {
    res = await fetch(target, { method: 'PUT', headers: h, body, signal, credentials: 'omit' });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError('Upload failed: cannot reach the upload target', {
      code: 'network_error',
      status: 0,
    });
  }
  if (!res.ok) {
    const err = await errorFromResponse(res);
    if (res.status === 401 && useAuth && unauthorizedHandler) unauthorizedHandler(err);
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return await res.json().catch(() => null);
  return null;
}

// ---------------------------------------------------------------------------
// Typed route groups — one function per route in docs/API.md
// ---------------------------------------------------------------------------

/** GET /meta (public, no auth) */
export const metaApi = {
  get: (opts = {}) => request('/meta', { ...opts, auth: false, timeout: opts.timeout ?? 8000 }),
};

/** POST /dev/token (only when authMode === "dev") */
export const devApi = {
  getToken: ({ email, name }) =>
    request('/dev/token', { method: 'POST', body: { email, name }, auth: false }),
};

/** User */
export const meApi = {
  get: () => request('/me'),
  update: (patch) => request('/me', { method: 'PATCH', body: patch }),
};

/** Cases */
export const casesApi = {
  list: () => request('/cases'),
  create: ({ title, description }) => request('/cases', { method: 'POST', body: { title, description } }),
  get: (caseId) => request(`/cases/${caseId}`),
  update: (caseId, patch) => request(`/cases/${caseId}`, { method: 'PATCH', body: patch }),
  remove: (caseId) => request(`/cases/${caseId}`, { method: 'DELETE' }),
};

/** Evidence */
export const evidenceApi = {
  list: (caseId) =>
    request(caseId ? `/evidence?caseId=${encodeURIComponent(caseId)}` : '/evidence'),
  get: (id) => request(`/evidence/${id}`),
  create: (body) => request('/evidence', { method: 'POST', body }),
  seal: (id) => request(`/evidence/${id}/seal`, { method: 'POST', body: {} }),
  remove: (id) => request(`/evidence/${id}`, { method: 'DELETE' }),
  forensics: (id) => request(`/evidence/${id}/forensics`, { method: 'POST', body: {} }),
  audit: (id) => request(`/evidence/${id}/audit`),
  listShares: (id) => request(`/evidence/${id}/shares`),
  createShare: (id, { includeDownload, expiresInHours } = {}) =>
    request(`/evidence/${id}/shares`, { method: 'POST', body: { includeDownload, expiresInHours } }),
  /** Raw PUT of the file bytes (uploadUrl + uploadHeaders from POST /evidence). */
  upload: (uploadUrl, file, uploadHeaders, opts = {}) =>
    putRaw(uploadUrl, file, uploadHeaders, opts),
  download: (id, { filename, fallbackName } = {}) =>
    downloadBlob(`/evidence/${id}/download`, {
      filename,
      fallbackName: fallbackName || 'evidence.bin',
    }),
};

/** Cloud page capture */
export const capturesApi = {
  list: (caseId) =>
    request(caseId ? `/captures?caseId=${encodeURIComponent(caseId)}` : '/captures'),
  create: ({ url, caseId, waitForContent }) =>
    request('/captures', { method: 'POST', body: { url, caseId, waitForContent } }),
  get: (captureId) => request(`/captures/${captureId}`),
};

/** Packages */
export const packagesApi = {
  list: (caseId) =>
    request(caseId ? `/packages?caseId=${encodeURIComponent(caseId)}` : '/packages'),
  create: ({ caseId, evidenceIds }) =>
    request('/packages', { method: 'POST', body: { caseId, evidenceIds } }),
  get: (id) => request(`/packages/${id}`),
  download: (id, { filename } = {}) =>
    downloadBlob(`/packages/${id}/download`, { filename: filename || `${id}.zip` }),
};

/** Shares */
export const sharesApi = {
  revoke: (shareId) => request(`/shares/${shareId}`, { method: 'DELETE' }),
};

/** Public verification (no auth, rate-limited) */
export const publicApi = {
  verify: (token, { deep = false, signal, timeout } = {}) =>
    request(`/public/verify/${token}${deep ? '?deep=1' : ''}`, {
      auth: false,
      signal,
      timeout: timeout ?? 20000,
    }),
  verifyBySha256: (sha256) =>
    request('/public/verify', { method: 'POST', body: { sha256 }, auth: false }),
  download: (token) =>
    downloadBlob(`/public/download/${token}`, { auth: false, fallbackName: 'original.bin' }),
  /**
   * GET /public/keys/{keyId} — keyId can contain slashes (alias/prooftrail-signing,
   * KMS ARNs). We send it raw first (works with wildcard / rest-of-path routing)
   * and fall back to percent-encoded.
   */
  key: async (keyId, opts = {}) => {
    try {
      return await request(`/public/keys/${keyId}`, { auth: false, ...opts });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) {
        return request(`/public/keys/${encodeURIComponent(keyId)}`, { auth: false, ...opts });
      }
      throw e;
    }
  },
  anchor: (root) => request(`/public/anchors/${root}`, { auth: false }),
};

/** Poll a fetcher until `isDone(result)` or timeout. Backoff + abort aware. */
export async function pollUntil(
  fetcher,
  {
    interval = 1500,
    maxInterval = 4000,
    backoff = 1.35,
    timeout = 180000,
    signal,
    isDone,
    onTick,
    maxErrors = 5,
  } = {}
) {
  const started = Date.now();
  let delay = interval;
  let errors = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    let result;
    try {
      result = await fetcher();
      errors = 0;
    } catch (e) {
      if (isAbort(e)) throw e;
      errors += 1;
      if (errors > maxErrors) throw e;
    }
    if (result !== undefined && result !== null) {
      if (onTick) onTick(result);
      if (isDone && isDone(result)) return result;
    }
    if (Date.now() - started > timeout) {
      throw new ApiError('Timed out waiting for the server', { code: 'timeout', status: 0 });
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.round(delay * backoff), maxInterval);
  }
}
