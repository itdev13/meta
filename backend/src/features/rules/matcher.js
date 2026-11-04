/**
 * Keyword matching + business hours. Pure functions (no DB) — the frontend mirrors matchRule in
 * src/lib/api-rules.js for the live "Test a message" box; keep the two in sync.
 *
 * Matching is case-insensitive, whitespace-collapsed, and keyword-boundary aware so "C" does not
 * fire on "Cancel" or "ok c" on "lock code":
 *   exact        whole message equals the keyword (surrounding punctuation/emoji ignored: "C!" = "c")
 *   contains     the keyword appears as a whole word/phrase anywhere
 *   starts_with  the message begins with the keyword as a whole word/phrase
 */
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function keywordMatches(matchType, text, keyword) {
  const t = normalize(text);
  const k = normalize(keyword);
  if (!t || !k) return false;
  if (matchType === 'exact') return t === k || t.replace(EDGE, '') === k.replace(EDGE, '');
  const kw = escapeRe(k);
  const after = '(?=$|[^\\p{L}\\p{N}])';
  if (matchType === 'starts_with') return new RegExp(`^${kw}${after}`, 'u').test(t);
  return new RegExp(`(?:^|(?<=[^\\p{L}\\p{N}]))${kw}${after}`, 'u').test(t);
}

/** First keyword of the rule that matches, or null. */
function matchRule(rule, text, sessionId) {
  if (!rule || rule.enabled === false) return null;
  if (sessionId && rule.sessionIds?.length && !rule.sessionIds.map(String).includes(String(sessionId))) return null;
  for (const kw of rule.keywords || []) if (keywordMatches(rule.matchType || 'exact', text, kw)) return kw;
  return null;
}

/** Rules sorted by priority → { rule, keyword } of the first match, or null. */
function firstMatch(rules, text, sessionId) {
  const sorted = [...(rules || [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  for (const rule of sorted) {
    const keyword = matchRule(rule, text, sessionId);
    if (keyword) return { rule, keyword };
  }
  return null;
}

// ── Business hours ────────────────────────────────────────────

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2])) : null;
};

/** { day: 0-6, minutes: 0-1439 } for `now` in the timezone. */
function localClock(timezone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { day: DAY_INDEX[parts.weekday] ?? 0, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/**
 * Is the business open right now? schedule[0..6] (Sun..Sat) = { open, start:'HH:MM', end:'HH:MM' }.
 * An end at or before the start spans midnight (e.g. 18:00 → 02:00), so the previous day's late
 * window is honoured after midnight.
 */
function isOpen(schedule, timezone, now = new Date()) {
  if (!Array.isArray(schedule) || schedule.length !== 7) return true;
  const { day, minutes } = localClock(timezone, now);
  const today = schedule[day];
  if (today?.open) {
    const s = toMin(today.start);
    const e = toMin(today.end);
    if (s !== null && e !== null) {
      if (e > s && minutes >= s && minutes < e) return true;
      if (e <= s && minutes >= s) return true; // overnight, before midnight
    }
  }
  const prev = schedule[(day + 6) % 7];
  if (prev?.open) {
    const s = toMin(prev.start);
    const e = toMin(prev.end);
    if (s !== null && e !== null && e <= s && minutes < e) return true; // overnight, after midnight
  }
  return false;
}

module.exports = { normalize, keywordMatches, matchRule, firstMatch, isOpen, localClock, toMin };
