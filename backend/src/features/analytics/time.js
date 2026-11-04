/**
 * Small timezone helpers (no library). Buckets are computed in Mongo with `timezone:`; Node only
 * needs to (a) validate an IANA zone, (b) find the start of "today minus N days" in that zone and
 * (c) label a Date with its local YYYY-MM-DD for the reply-rate pass.
 */
const DAY = 24 * 60 * 60 * 1000;
const fmtCache = new Map();

function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return null;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function parts(date, tz) {
  const p = {};
  for (const x of formatter(tz).formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** Offset of `tz` from UTC at `date`, in ms (positive east of Greenwich). */
function offsetMs(date, tz) {
  const p = parts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Local calendar day "YYYY-MM-DD" of `date` in `tz`. */
function dayKey(date, tz) {
  const p = parts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/**
 * Window for "last N days" ending now: starts at local midnight of (today − N + 1) so every daily
 * bucket is a whole local day, and the list of day keys to zero-fill the series with.
 */
function rangeWindow(days, tz, now = new Date()) {
  const p = parts(now, tz);
  const firstUtcMidnight = Date.UTC(p.y, p.m - 1, p.d - (days - 1));
  const since = new Date(firstUtcMidnight - offsetMs(new Date(firstUtcMidnight), tz));
  const keys = [];
  for (let i = 0; i < days; i += 1) keys.push(new Date(firstUtcMidnight + i * DAY).toISOString().slice(0, 10));
  return { since, until: now, keys };
}

module.exports = { DAY, validTimeZone, dayKey, rangeWindow };
