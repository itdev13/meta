const { DAY, dayKey } = require('./time');

/**
 * Bounded in-Node pass for the two metrics that need message ORDER per chat:
 *
 *  Reply rate     — an "outbound conversation" is (chat, local day) with ≥1 outbound message. It
 *                   counts as replied when the contact wrote back within 24h of that day's first
 *                   outbound. Conversations younger than 24h with no reply yet are "pending" and
 *                   left out of the rate so today never looks artificially bad.
 *
 *  First response — every inbound that arrives while nobody is "on the hook" opens a waiting
 *                   period; it closes at the next outbound to the same chat on the same number.
 *                   Two flavours: `team` counts only replies from people (CRM agents, phone),
 *                   `all` also counts workflow sends and auto-replies. Waits over 24h are counted
 *                   as unanswered instead of skewing the percentiles.
 *
 * Rows: [{ sessionId, locationId, waJid, direction, source, createdAt }] in any order. A chat is
 * keyed by sessionId + waJid (the same person on two numbers is two chats).
 * `groupBy(row)` → extra bucket keys (e.g. sessionId, locationId) to aggregate per-entity results.
 */
const TEAM_SOURCES = new Set(['ghl', 'phone']);

function newBucket() {
  return { conversations: 0, replied: 0, pending: 0, team: [], all: [], unanswered: 0, open: 0 };
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function summarize(b) {
  const team = [...b.team].sort((a, x) => a - x);
  const all = [...b.all].sort((a, x) => a - x);
  const decided = b.conversations - b.pending;
  return {
    replies: { conversations: b.conversations, replied: b.replied, pending: b.pending, rate: decided > 0 ? b.replied / decided : null },
    responseTime: {
      medianMs: percentile(team, 0.5),
      p90Ms: percentile(team, 0.9),
      samples: team.length,
      unanswered: b.unanswered,
      open: b.open,
      all: { medianMs: percentile(all, 0.5), p90Ms: percentile(all, 0.9), samples: all.length },
    },
  };
}

function firstAfter(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo < times.length ? times[lo] : null;
}

function analyzeConversations(rows, { tz, now = Date.now(), groupBy = () => [] } = {}) {
  const chats = new Map();
  for (const r of rows) {
    if (!r.waJid) continue;
    const key = `${r.sessionId}|${r.waJid}`;
    let c = chats.get(key);
    if (!c) {
      c = { rows: [], groups: groupBy(r) };
      chats.set(key, c);
    }
    c.rows.push(r);
  }

  const overall = newBucket();
  const groups = new Map();
  const bucketsFor = (keys) => [overall, ...keys.map((k) => {
    if (!groups.has(k)) groups.set(k, newBucket());
    return groups.get(k);
  })];

  for (const c of chats.values()) {
    const list = c.rows.sort((a, b) => a.createdAt - b.createdAt);
    const targets = bucketsFor(c.groups);
    const push = (field, v) => targets.forEach((b) => (field === 'inc' ? (b[v] += 1) : b[field].push(v)));

    // Reply rate
    const inboundTimes = [];
    const firstOutByDay = new Map();
    for (const r of list) {
      const t = new Date(r.createdAt).getTime();
      if (r.direction === 'inbound') inboundTimes.push(t);
      else {
        const day = dayKey(new Date(t), tz);
        if (!firstOutByDay.has(day)) firstOutByDay.set(day, t);
      }
    }
    for (const t0 of firstOutByDay.values()) {
      push('inc', 'conversations');
      const reply = firstAfter(inboundTimes, t0);
      if (reply != null && reply - t0 <= DAY) push('inc', 'replied');
      else if (now - t0 < DAY) push('inc', 'pending');
    }

    // First response time
    let waitTeam = null;
    let waitAll = null;
    for (const r of list) {
      const t = new Date(r.createdAt).getTime();
      if (r.direction === 'inbound') {
        if (waitTeam == null) waitTeam = t;
        if (waitAll == null) waitAll = t;
        continue;
      }
      if (waitAll != null) {
        if (t - waitAll <= DAY) push('all', t - waitAll);
        waitAll = null;
      }
      if (waitTeam != null && TEAM_SOURCES.has(r.source)) {
        if (t - waitTeam <= DAY) push('team', t - waitTeam);
        else push('inc', 'unanswered');
        waitTeam = null;
      }
    }
    if (waitTeam != null) push('inc', now - waitTeam > DAY ? 'unanswered' : 'open');
  }

  const byGroup = {};
  for (const [k, b] of groups) byGroup[k] = summarize(b);
  return { overall: summarize(overall), byGroup };
}

module.exports = { analyzeConversations, percentile };
