export function timeAgo(date) {
  if (!date) return '—';
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "+919999912345" → "+91 99999 12345" (light grouping, no library). */
export function formatPhone(p) {
  if (!p) return '';
  const d = String(p).replace(/[^\d]/g, '');
  if (d.length <= 6) return `+${d}`;
  const cc = d.length > 10 ? d.slice(0, d.length - 10) : '';
  const rest = cc ? d.slice(cc.length) : d;
  const body = rest.length === 10 ? `${rest.slice(0, 5)} ${rest.slice(5)}` : rest.replace(/(\d{3})(?=\d)/g, '$1 ');
  return `${cc ? `+${cc} ` : '+'}${body}`.trim();
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export const STATUS_META = {
  connected: { label: 'Connected', tone: 'ok' },
  connecting: { label: 'Connecting', tone: 'info' },
  pending: { label: 'Starting', tone: 'info' },
  qr: { label: 'Waiting for scan', tone: 'info' },
  pairing: { label: 'Waiting for code', tone: 'info' },
  disconnected: { label: 'Reconnecting', tone: 'warn' },
  paused: { label: 'Paused', tone: 'neutral' },
  qr_expired: { label: 'Not linked', tone: 'neutral' },
  logged_out: { label: 'Logged out', tone: 'err' },
  banned: { label: 'Blocked by WhatsApp', tone: 'err' },
  replaced: { label: 'Opened elsewhere', tone: 'err' },
};

export const PAUSE_REASON = {
  agency_disabled: 'Paused by your agency',
  plan_limit: 'Paused — over plan limit',
  manual: 'Paused',
};

export function statusMeta(status, pausedReason) {
  const m = STATUS_META[status] || { label: status, tone: 'neutral' };
  if (status === 'paused' && pausedReason) return { ...m, label: PAUSE_REASON[pausedReason] || m.label };
  return m;
}

export function subscriptionLabel(sub) {
  const n = sub?.numberLimit;
  const limit = n ? ` · up to ${n} ${n === 1 ? 'number' : 'numbers'}` : '';
  // Billing switched off on the server → WhatsApp is free to use, whatever the record says.
  if (sub?.required === false) return { label: 'Included', tone: 'ok', detail: `No subscription needed${limit}` };
  if (!sub || !sub.status || sub.status === 'inactive') {
    return { label: 'Not subscribed', tone: 'neutral', detail: 'Hasn’t picked a plan in the marketplace yet' };
  }
  if (sub.status === 'trialing') {
    const days = sub.trialEndsAt ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt) - Date.now()) / 86400000)) : sub.trialDaysLeft;
    return { label: `Trial · ${days ?? 0}d left`, tone: 'info', detail: `Free trial${limit}` };
  }
  if (sub.status === 'active') return { label: sub.planName || sub.plan?.name || 'Active', tone: 'ok', detail: `Paid plan${limit}` };
  if (sub.status === 'past_due') return { label: 'Payment failed', tone: 'err', detail: 'The last marketplace payment didn’t go through' };
  if (sub.status === 'canceled') return { label: 'Canceled', tone: 'neutral', detail: 'The plan was canceled in the marketplace' };
  return { label: 'Not subscribed', tone: 'neutral', detail: 'Hasn’t picked a plan in the marketplace yet' };
}
