// SHA-256 helpers on top of WebCrypto (works in every modern browser, no deps).

/** ArrayBuffer | TypedArray | string -> lowercase hex string. */
export function bufferToHex(buffer) {
  let bytes;
  if (typeof buffer === 'string') {
    bytes = new TextEncoder().encode(buffer);
  } else if (buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(buffer);
  } else if (ArrayBuffer.isView(buffer)) {
    bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } else {
    throw new Error('bufferToHex: unsupported input');
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** SHA-256 of a string (UTF-8), ArrayBuffer, TypedArray or Blob/File. Returns hex. */
export async function sha256Hex(data) {
  let buf;
  if (data instanceof Blob) {
    buf = await data.arrayBuffer();
  } else if (typeof data === 'string') {
    buf = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) {
    buf = data;
  } else if (ArrayBuffer.isView(data)) {
    buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } else {
    throw new Error('sha256Hex: unsupported input');
  }
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return bufferToHex(digest);
}

/** SHA-256 of a File/Blob (used by the capture page and verification portal). */
export function sha256OfFile(file) {
  return sha256Hex(file);
}

export function isHexString(s) {
  return typeof s === 'string' && /^[0-9a-f]+$/.test(s);
}

export function sameHex(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
