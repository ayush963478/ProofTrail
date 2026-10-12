// Error codes + statuses from docs/API.md.
//
// Non-2xx responses use the envelope:
//   { "error": { "code": "validation_error", "message": "human readable" } }

export const CODE_STATUS = Object.freeze({
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  payload_too_large: 413,
  hash_mismatch: 422,
  rate_limited: 429,
  internal_error: 500,
  not_implemented: 501,
});

export class AppError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? CODE_STATUS[code] ?? 500;
    this.expose = true;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

const make = (code) => (message) => new AppError(code, message);

export const errors = {
  validation: make('validation_error'),
  unauthorized: make('unauthorized'),
  forbidden: make('forbidden'),
  notFound: make('not_found'),
  conflict: make('conflict'),
  gone: make('gone'),
  payloadTooLarge: make('payload_too_large'),
  hashMismatch: make('hash_mismatch'),
  rateLimited: make('rate_limited'),
  internal: make('internal_error'),
  notImplemented: make('not_implemented'),
};

export function isAppError(err) {
  return err instanceof AppError || (err && typeof err.code === 'string' && CODE_STATUS[err.code] !== undefined);
}

/** Normalize any thrown value into an AppError with an API.md code. */
export function toAppError(err) {
  if (isAppError(err)) return err;
  const message = err && err.message ? String(err.message) : 'Internal server error';
  const e = new AppError('internal_error', message);
  e.expose = false;
  return e;
}
