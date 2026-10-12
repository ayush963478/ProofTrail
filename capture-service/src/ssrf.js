// SSRF guard for the cloud capture service.
//
// Two layers:
//   1. literal checks on the URL hostname (fast path, runs for every request
//      the browser makes via request interception),
//   2. DNS resolution checks: every resolved address must be a public,
//      globally-routable unicast address (runs before navigation and for each
//      intercepted request host, with a short-lived per-host cache).
//
// The guard is intentionally conservative: any address in a private,
// loopback, link-local, CGNAT, multicast or metadata range rejects the URL.

import dns from 'node:dns/promises';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

/** IPv4 ranges that must never be reached (returns true when blocked). */
export function ipv4IsPrivate(ip) {
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 TEST-NET-1
  if (a === 198 && b === 18) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 19) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 203.0.113.0/24
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** IPv6 addresses that must never be reached. */
export function ipv6IsPrivate(raw) {
  const ip = raw.toLowerCase().split('%')[0]; // strip zone id
  if (ip === '::' || ip === '::1') return true;
  // IPv4-mapped / IPv4-compatible
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);
  const first = Number.parseInt(ip.split(':')[0] || '0', 16);
  if (Number.isNaN(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Address (v4 or v6) guard. */
export function addressIsPrivate(addr) {
  return addr.includes(':') ? ipv6IsPrivate(addr) : ipv4IsPrivate(addr);
}

/**
 * Synchronous hostname guard (no DNS): literal names and IP-literal hosts.
 * @returns {string|null} rejection reason, or null when the host looks fine
 */
export function hostnameRejectReason(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return 'empty hostname';
  if (BLOCKED_HOSTS.has(host)) return 'refusing to capture private/metadata hosts';
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'refusing to capture private hostnames';
  }
  // IP literal?
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return ipv4IsPrivate(host) ? `refusing to capture private address ${host}` : null;
  }
  if (host.includes(':')) {
    return ipv6IsPrivate(host) ? `refusing to capture private address ${host}` : null;
  }
  return null;
}

// hostname -> { ok, reason, until } short-lived cache (DNS can't change fast)
const dnsCache = new Map();
const DNS_TTL_MS = 30_000;

/** Resolve host and reject when ANY address is in a private range. */
export async function hostResolvesPublic(hostname, { lookup, now = Date.now } = {}) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const cached = dnsCache.get(host);
  if (cached && cached.until > now()) return cached;
  let result;
  try {
    const fn = lookup || ((h) => dns.lookup(h, { all: true, verbatim: true }));
    const addrs = await fn(host);
    const list = Array.isArray(addrs) ? addrs : [addrs];
    const bad = list.map((a) => (typeof a === 'string' ? a : a.address)).find((a) => addressIsPrivate(a));
    result = bad
      ? { ok: false, reason: `${hostname} resolves to private address ${bad}` }
      : { ok: true, reason: null };
  } catch (err) {
    // NXDOMAIN etc. — let the browser produce the real navigation error.
    result = { ok: true, reason: null, dnsError: err.code || err.message };
  }
  result.until = now() + DNS_TTL_MS;
  dnsCache.set(host, result);
  return result;
}

/**
 * Full guard for a URL about to be fetched.
 * @returns {Promise<string>} the normalized URL
 * @throws {Error} when the URL must not be captured
 */
export async function assertUrlAllowed(rawUrl, opts = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http/https URLs can be captured (got ${url.protocol})`);
  }
  const literal = hostnameRejectReason(url.hostname);
  if (literal) throw new Error(literal);
  const dnsCheck = await hostResolvesPublic(url.hostname, opts);
  if (!dnsCheck.ok) throw new Error(dnsCheck.reason);
  return url.toString();
}

/**
 * Per-request guard used by the Puppeteer interception hook.
 * @returns {Promise<{allow: boolean, reason?: string}>}
 */
export async function checkRequestUrl(rawUrl, opts = {}) {
  try {
    await assertUrlAllowed(rawUrl, opts);
    return { allow: true };
  } catch (err) {
    return { allow: false, reason: err.message };
  }
}

/** Test helper: forget cached DNS results. */
export function clearDnsCache() {
  dnsCache.clear();
}
