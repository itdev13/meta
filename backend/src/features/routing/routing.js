/**
 * Number routing helpers (feature: routing) — pure functions shared by MessagingService
 * (pickRoute) and workflows. No I/O here except the small contact cache.
 *
 * Priority (see MessagingService.pickRoute):
 *   explicit → {WA#n} override → contact tag "wa: +1555…" → contact's assigned user →
 *   sending user → last used → default → most recently active.
 */
const { digits } = require('../../whatsapp/jid');

const TAG_PREFIX = 'wa:';

// {WA#2} | {wa#2} | {WA #2} | { wa # 2 }  — case-insensitive, with an optional surrounding space.
const OVERRIDE_RE = /( ?)\{\s*wa\s*#\s*(\d{1,3})\s*\}( ?)/gi;

/**
 * Find and strip every {WA#n} token. Returns { index, text } — index is the FIRST token's n
 * (or null). A token between two words keeps one space ("Hi {WA#2} there" → "Hi there").
 */
function extractOverride(text) {
  if (!text || typeof text !== 'string' || !/\{\s*wa\s*#/i.test(text)) return { index: null, text };
  let index = null;
  const stripped = text.replace(OVERRIDE_RE, (_m, before, n, after) => {
    if (index === null) index = Number(n);
    return before && after ? ' ' : '';
  });
  return { index, text: stripped.trim() };
}

/** Phones match if digits are equal, or one ends with the other (≥ 8 digits; local vs E.164). */
function samePhone(a, b) {
  const x = digits(a);
  const y = digits(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 8 && long.endsWith(short);
}

/** "wa: +15462342515" / "WA:+1 (546) 234-2515" → "15462342515"; anything else → null. */
function tagPhone(tag) {
  const m = /^\s*wa\s*:\s*(\+?[\d\s\-().]{6,})\s*$/i.exec(String(tag || ''));
  if (!m) return null;
  const d = digits(m[1]);
  return d.length >= 6 ? d : null;
}

/**
 * Resolve a number reference against a list of sessions. Accepts a session id, an index
 * ("2", "#2", "WA#2", "WhatsApp #2") or a phone number. Returns the session or null.
 */
function resolveNumberRef(sessions, ref) {
  if (ref === undefined || ref === null) return null;
  const raw = String(ref).trim();
  if (!raw) return null;
  const byId = sessions.find((s) => String(s._id) === raw);
  if (byId) return byId;
  const idx = /^(?:\{?\s*(?:wa|whatsapp)\s*)?#?\s*(\d{1,3})\s*\}?$/i.exec(raw);
  if (idx) {
    const n = Number(idx[1]);
    const hit = sessions.find((s) => Number(s.index) === n);
    if (hit) return hit;
  }
  if (digits(raw).length >= 6) return sessions.find((s) => samePhone(s.phoneNumber, raw)) || null;
  return null;
}

function numberName(s) {
  if (!s) return '?';
  return `${s.index ? `WhatsApp #${s.index}` : 'WhatsApp'}${s.phoneNumber ? ` (${s.phoneNumber})` : ''}`;
}

/** Tiny TTL cache (Map) with a hard size cap. */
class TtlCache {
  constructor(ttlMs, max = 5000) {
    this.ttl = ttlMs;
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value) {
    if (this.map.size >= this.max) {
      const now = Date.now();
      for (const [k, v] of this.map) if (v.exp < now) this.map.delete(k);
      if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { value, exp: Date.now() + this.ttl });
  }
}

module.exports = { TAG_PREFIX, extractOverride, resolveNumberRef, tagPhone, samePhone, numberName, TtlCache };
