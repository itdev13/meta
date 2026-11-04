import { api } from './api';

/** Viewer's IANA zone — days and the busiest-hours heatmap are bucketed in it server-side. */
export function viewerTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
  return q.toString();
}

export const analytics = {
  /** → see backend/src/features/analytics/analytics.service.js (_location) for the shape. */
  location: (locationId, { range = '30d', sessionId } = {}) =>
    api.get(`/api/locations/${encodeURIComponent(locationId)}/analytics?${qs({ range, sessionId, tz: viewerTimeZone() })}`),
  /** → see _agency in the same file. */
  agency: ({ range = '30d' } = {}) => api.get(`/api/agency/analytics?${qs({ range, tz: viewerTimeZone() })}`),
};

// ── Formatting shared by the analytics screens ──────────────────────

export function fmtInt(n) {
  if (n == null) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString();
}

export function fmtPct(r, digits = 0) {
  if (r == null || Number.isNaN(r)) return '—';
  const v = r * 100;
  return `${v > 0 && v < 1 && digits === 0 ? v.toFixed(1) : v.toFixed(digits)}%`;
}

export function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const SHORT_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const LONG_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "2026-10-04" → "Oct 4" (date-only keys are parsed as UTC so they never shift). */
export const fmtDay = (key, long) => (long ? LONG_DAY : SHORT_DAY).format(new Date(`${key}T00:00:00Z`));
