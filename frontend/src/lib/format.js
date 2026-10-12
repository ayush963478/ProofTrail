// Formatting helpers shared across pages.

export function formatBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const num = Number(n);
  if (num < 1024) return `${num} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = num;
  let i = -1;
  do {
    value /= 1024;
    i += 1;
  } while (value >= 1024 && i < units.length - 1);
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDateShort(iso);
}

export function truncate(str, head = 12, tail = 8) {
  const s = String(str ?? '');
  if (s.length <= head + tail + 1) return s;
  // NB: s.slice(-0) would return the whole string — use an offset instead so
  // tail=0 means "head only" (e.g. the user-agent row on EvidenceDetail).
  return `${s.slice(0, head)}…${s.slice(Math.max(0, s.length - tail))}`;
}

/** 0x-style short hash display: first `head` + last `tail` hex chars. */
export function shortHash(hex, head = 14, tail = 10) {
  return truncate(hex, head, tail);
}

export function capitalize(s) {
  const str = String(s || '');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function planLabel(plan) {
  const map = { free: 'Free', personal: 'Personal', pro: 'Pro', enterprise: 'Enterprise' };
  return map[plan] || capitalize(plan || 'Free');
}

export function clampPercent(confidence) {
  const n = Number(confidence);
  if (Number.isNaN(n)) return 0;
  return n <= 1 ? Math.round(n * 100) : Math.min(100, Math.round(n));
}
