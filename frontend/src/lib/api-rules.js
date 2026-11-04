import { api } from './api';

/** Rules feature API: templates, keyword rules, away + welcome. */
export const rulesApi = (locationId) => {
  const base = `/api/locations/${encodeURIComponent(locationId)}/rules`;
  return {
    overview: () => api.get(base),
    // templates
    templates: () => api.get(`${base}/templates`),
    createTemplate: (b) => api.post(`${base}/templates`, b),
    updateTemplate: (id, b) => api.put(`${base}/templates/${id}`, b),
    deleteTemplate: (id) => api.del(`${base}/templates/${id}`),
    preview: (b) => api.post(`${base}/templates/preview`, b),
    // rules
    rules: () => api.get(`${base}/list`),
    createRule: (b) => api.post(`${base}/list`, b),
    updateRule: (id, b) => api.put(`${base}/list/${id}`, b),
    deleteRule: (id) => api.del(`${base}/list/${id}`),
    reorder: (ids) => api.post(`${base}/reorder`, { ids }),
    test: (b) => api.post(`${base}/test`, b),
    // away / welcome
    away: () => api.get(`${base}/away`),
    saveAway: (b) => api.put(`${base}/away`, b),
    welcome: () => api.get(`${base}/welcome`),
    saveWelcome: (b) => api.put(`${base}/welcome`, b),
    hours: () => api.get(`${base}/hours`),
    stats: () => api.get(`${base}/stats`),
  };
};

export const VARIABLES = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'name', label: 'Full name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'business_name', label: 'Business' },
  { key: 'date', label: 'Date' },
  { key: 'time', label: 'Time' },
];

export const SAMPLE = { first_name: 'Alex', last_name: 'Morgan', name: 'Alex Morgan', phone: '+14155550123', email: 'alex@example.com' };

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|([^}]*))?\}\}/g;

/** Instant client-side render with sample data (server preview is the source of truth). */
export function renderSample(text, { businessName = 'Your business', timezone } = {}) {
  const now = new Date();
  const tz = timezone || undefined;
  const fmt = (o) => {
    try {
      return new Intl.DateTimeFormat('en-US', { ...o, timeZone: tz }).format(now);
    } catch {
      return new Intl.DateTimeFormat('en-US', o).format(now);
    }
  };
  const values = { ...SAMPLE, full_name: SAMPLE.name, business_name: businessName, location_name: businessName, date: fmt({ dateStyle: 'medium' }), time: fmt({ timeStyle: 'short' }) };
  return String(text || '').replace(VAR_RE, (_, name, fb) => values[name] || (fb !== undefined ? fb.trim() : name.startsWith('contact.') ? `‹${name.slice(8)}›` : ''));
}

export function variablesIn(text) {
  return [...new Set([...String(text || '').matchAll(VAR_RE)].map((m) => m[1]))];
}

// ── Matching (mirror of backend/src/features/rules/matcher.js — keep in sync) ──
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
export const normalize = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function keywordMatches(matchType, text, keyword) {
  const t = normalize(text);
  const k = normalize(keyword);
  if (!t || !k) return false;
  if (matchType === 'exact') return t === k || t.replace(EDGE, '') === k.replace(EDGE, '');
  const after = '(?=$|[^\\p{L}\\p{N}])';
  if (matchType === 'starts_with') return new RegExp(`^${esc(k)}${after}`, 'u').test(t);
  return new RegExp(`(?:^|(?<=[^\\p{L}\\p{N}]))${esc(k)}${after}`, 'u').test(t);
}

export function matchRule(rule, text, sessionId) {
  if (!rule || rule.enabled === false) return null;
  if (sessionId && rule.sessionIds?.length && !rule.sessionIds.includes(sessionId)) return null;
  for (const kw of rule.keywords || []) if (keywordMatches(rule.matchType || 'exact', text, kw)) return kw;
  return null;
}

export function firstMatch(rules, text, sessionId) {
  const sorted = [...(rules || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  for (const rule of sorted) {
    const keyword = matchRule(rule, text, sessionId);
    if (keyword) return { rule, keyword };
  }
  return null;
}

// ── Business hours (mirror of matcher.isOpen) ──
const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export function isOpenNow(schedule, timezone) {
  if (!Array.isArray(schedule) || schedule.length !== 7) return true;
  let parts;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date())
        .map((p) => [p.type, p.value]),
    );
  } catch {
    return true;
  }
  const day = DAYS[parts.weekday] ?? 0;
  const min = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  const d = schedule[day];
  if (d?.open) {
    const s = toMin(d.start);
    const e = toMin(d.end);
    if (s !== null && e !== null && ((e > s && min >= s && min < e) || (e <= s && min >= s))) return true;
  }
  const p = schedule[(day + 6) % 7];
  if (p?.open) {
    const s = toMin(p.start);
    const e = toMin(p.end);
    if (s !== null && e !== null && e <= s && min < e) return true;
  }
  return false;
}

export function timezones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone');
  } catch {
    /* fall through */
  }
  return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── Starters ──
export const STARTER_CONFIRM = [
  {
    name: 'Confirm appointment',
    matchType: 'exact',
    keywords: ['c', 'confirm', 'yes'],
    reply: { mode: 'text', text: 'Thanks {{first_name|there}}, your appointment is confirmed ✅ See you soon!' },
    tags: ['appointment-confirmed'],
    fireTrigger: true,
    cooldownMinutes: 60,
  },
  {
    name: 'Reschedule request',
    matchType: 'exact',
    keywords: ['r', 'reschedule'],
    reply: { mode: 'text', text: 'No problem {{first_name|there}} — a member of the {{business_name}} team will message you shortly to find a new time.' },
    tags: ['reschedule-requested'],
    fireTrigger: true,
    cooldownMinutes: 60,
  },
];

export const STARTER_RULES = [
  { name: 'Pricing question', matchType: 'contains', keywords: ['price', 'pricing', 'cost', 'how much'], reply: { mode: 'text', text: 'Hi {{first_name|there}}! Thanks for asking about pricing. Tell us what you need and we’ll send you a quote shortly.' }, tags: ['asked-pricing'], fireTrigger: true, cooldownMinutes: 1440 },
  { name: 'Opening hours', matchType: 'contains', keywords: ['hours', 'open', 'opening times'], reply: { mode: 'text', text: 'We’re open Monday–Friday, 9am–5pm. Message us anytime and we’ll reply as soon as we’re in.' }, tags: [], fireTrigger: false, cooldownMinutes: 720 },
];

export const STARTER_TEMPLATES = [
  { name: 'Appointment reminder', category: 'appointments', body: 'Hi {{first_name|there}}, this is a reminder of your appointment with {{business_name}}.\n\nReply *C* to confirm or *R* to reschedule.' },
  { name: 'Thanks for reaching out', category: 'support', body: 'Thanks for messaging {{business_name}}, {{first_name|there}}! A team member will be with you shortly.' },
  { name: 'Follow-up', category: 'sales', body: 'Hi {{first_name|there}}, just checking in — is there anything else we can help you with?' },
];

export const CATEGORIES = ['general', 'appointments', 'sales', 'support', 'follow-up', 'marketing'];
