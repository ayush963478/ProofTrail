// Lambda adapter: API Gateway HTTP API (payload format 2.0) event →
// router ctx → handle() → API Gateway result.
//
// Local mode reuses the same `handle()` directly (see handlers + local-server).

import { loadConfig } from './config.js';
import { handle } from './router.js';
import { toLambdaResult } from './http.js';

/** Normalize an API Gateway v2 event into the router ctx shape. */
export function normalizeEvent(event) {
  const method = event?.requestContext?.http?.method || event?.httpMethod || 'GET';
  const rawPath = event?.rawPath || event?.path || '/';
  const query = {};
  for (const [k, v] of Object.entries(event?.queryStringParameters || {})) {
    if (v !== undefined && v !== null) query[k] = String(v);
  }
  const headers = {};
  for (const [k, v] of Object.entries(event?.headers || {})) {
    if (v !== undefined && v !== null) headers[k.toLowerCase()] = String(v);
  }
  let raw = Buffer.alloc(0);
  if (typeof event?.body === 'string' && event.body.length > 0) {
    raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8');
  }
  return {
    method,
    path: rawPath,
    query,
    headers,
    raw,
    ip: event?.requestContext?.http?.sourceIp || '0.0.0.0',
    requestId: event?.requestContext?.requestId,
  };
}

/**
 * Wrap a route table into a Lambda handler.
 * @param {Array} routes  [{method, path, auth?, handler, rate?}]
 * @returns {Function} async (event) => APIGW v2 result
 */
export function makeHandler(routes, cfg = loadConfig()) {
  return async (event) => {
    const ctx = normalizeEvent(event);
    const res = await handle(ctx, routes, cfg);
    return toLambdaResult(res);
  };
}
