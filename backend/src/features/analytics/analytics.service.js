const MessageLog = require('../../schemas/message-log.schema');
const WaSession = require('../../schemas/wa-session.schema');
const { DAY, validTimeZone, rangeWindow } = require('./time');
const { analyzeConversations } = require('./conversations');

/**
 * Analytics over MessageLog (90-day TTL, so 90d is the longest honest window).
 *
 * Cost model, per request:
 *   1. One $facet aggregation over the range, $match first on {locationId|companyId, createdAt}
 *      (both have compound indexes). Every facet is a $group → output is small and bounded.
 *   2. One contacts aggregation over the 90-day retention window, inbound only, grouped by waJid →
 *      two counts (unique in range, first seen in range).
 *   3. One bounded find() for reply rate / first response: most recent ROW_CAP rows of the range,
 *      projection of 6 small fields, index-ordered by createdAt. If truncated, the response says so.
 * Results are cached in-process for CACHE_MS per (scope, params).
 */
const RANGES = { '7d': 7, '30d': 30, '90d': 90 };
const RETENTION_DAYS = 90;
const ROW_CAP = 50_000;
const CACHE_MS = 60_000;
const CACHE_MAX = 500;
const OUT_SOURCES = ['ghl', 'workflow', 'auto', 'phone'];

const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'BAD_REQUEST' });
}

function parseQuery(q = {}) {
  const range = RANGES[q.range] ? q.range : '30d';
  const tz = validTimeZone(q.tz) || 'UTC';
  const sessionId = q.sessionId ? String(q.sessionId) : null;
  if (sessionId && !/^[a-f0-9]{24}$/i.test(sessionId)) throw badRequest('sessionId is not valid');
  return { range, days: RANGES[range], tz, sessionId };
}

const rate = (n, d) => (d > 0 ? n / d : null);

/** "Error: Connection Closed (id 3EB0…)" → "connection closed" — groups near-identical errors. */
function normalizeReason(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Unknown error';
  const clean = s
    .replace(/^(error|err)\s*[:-]\s*/i, '')
    .replace(/\b[0-9a-f]{12,}\b/gi, '…')
    .replace(/\+?\d[\d\s-]{5,}\d/g, '…')
    .replace(/\s+/g, ' ')
    .slice(0, 90);
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function facetStages(tz, { perLocation }) {
  const facets = {
    totals: [{ $group: { _id: { d: '$direction', src: '$source', s: '$status' }, n: { $sum: 1 } } }],
    series: [
      {
        $group: {
          _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, d: '$direction' },
          n: { $sum: 1 },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        },
      },
    ],
    heatmap: [
      { $match: { direction: 'inbound' } },
      {
        $group: {
          _id: { dow: { $isoDayOfWeek: { date: '$createdAt', timezone: tz } }, h: { $hour: { date: '$createdAt', timezone: tz } } },
          n: { $sum: 1 },
        },
      },
    ],
    keywords: [
      { $match: { keyword: { $type: 'string', $ne: '' } } },
      { $group: { _id: { $toLower: '$keyword' }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 12 },
    ],
    failures: [
      { $match: { status: 'failed' } },
      { $group: { _id: { $substrCP: [{ $ifNull: ['$error', ''] }, 0, 160] }, n: { $sum: 1 }, last: { $max: '$createdAt' } } },
      { $sort: { n: -1 } },
      { $limit: 60 },
    ],
    groups: [{ $match: { isGroup: true } }, { $count: 'n' }],
  };
  if (perLocation) facets.byLocation = [{ $group: { _id: { l: '$locationId', d: '$direction', s: '$status' }, n: { $sum: 1 } } }];
  else facets.bySession = [{ $group: { _id: { id: '$sessionId', d: '$direction', s: '$status' }, n: { $sum: 1 } } }];
  return facets;
}

function emptyCounts() {
  return { inbound: 0, outbound: 0, delivered: 0, read: 0, failed: 0, failedOutbound: 0, pending: 0, outboundSettled: 0 };
}

function addCount(c, direction, status, n) {
  if (direction === 'inbound') {
    c.inbound += n;
    if (status === 'failed') c.failed += n;
    return;
  }
  c.outbound += n;
  if (status === 'pending') c.pending += n;
  else c.outboundSettled += n;
  if (status === 'delivered' || status === 'read') c.delivered += n;
  if (status === 'read') c.read += n;
  if (status === 'failed') {
    c.failed += n;
    c.failedOutbound += n;
  }
}

function countsOut(c) {
  return {
    inbound: c.inbound,
    outbound: c.outbound,
    delivered: c.delivered,
    read: c.read,
    failed: c.failed,
    failedOutbound: c.failedOutbound,
    deliveryRate: rate(c.delivered, c.outboundSettled),
    readRate: rate(c.read, c.outboundSettled),
    failRate: rate(c.failedOutbound, c.outboundSettled),
  };
}

function shapeFacets(f, keys) {
  // Totals
  const c = emptyCounts();
  const outboundBySource = Object.fromEntries(OUT_SOURCES.map((s) => [s, 0]));
  for (const r of f.totals) {
    addCount(c, r._id.d, r._id.s, r.n);
    if (r._id.d === 'outbound' && r._id.src in outboundBySource) outboundBySource[r._id.src] += r.n;
  }

  // Daily series, zero-filled
  const byDay = new Map(keys.map((k) => [k, { date: k, inbound: 0, outbound: 0, failed: 0 }]));
  for (const r of f.series) {
    const row = byDay.get(r._id.day);
    if (!row) continue;
    row[r._id.d] += r.n;
    row.failed += r.failed;
  }

  // 7×24, Monday first
  const cells = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const r of f.heatmap) {
    const v = (cells[r._id.dow - 1][r._id.h] += r.n);
    if (v > max) max = v;
  }

  // Failure reasons, merged after normalising
  const reasons = new Map();
  for (const r of f.failures) {
    const reason = normalizeReason(r._id);
    const e = reasons.get(reason) || { reason, count: 0, lastAt: null };
    e.count += r.n;
    if (!e.lastAt || r.last > e.lastAt) e.lastAt = r.last;
    reasons.set(reason, e);
  }

  return {
    counts: c,
    totals: {
      inbound: c.inbound,
      outbound: c.outbound,
      outboundBySource,
      delivered: c.delivered,
      read: c.read,
      failed: c.failed,
      failedOutbound: c.failedOutbound,
      failedInbound: c.failed - c.failedOutbound,
      pending: c.pending,
      groupMessages: f.groups[0]?.n || 0,
    },
    rates: {
      delivery: rate(c.delivered, c.outboundSettled),
      read: rate(c.read, c.outboundSettled),
      failure: rate(c.failedOutbound, c.outboundSettled),
    },
    series: [...byDay.values()],
    heatmap: { cells, max, weekStartsOn: 'monday' },
    keywords: f.keywords.map((r) => ({ keyword: r._id, count: r.n })),
    failures: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

async function contactCounts(match, since) {
  const retentionStart = new Date(Date.now() - RETENTION_DAYS * DAY);
  const { createdAt, ...scope } = match; // eslint-disable-line no-unused-vars
  const [r] = await MessageLog.aggregate([
    { $match: { ...scope, createdAt: { $gte: retentionStart }, direction: 'inbound', isGroup: { $ne: true }, waJid: { $type: 'string' } } },
    { $group: { _id: '$waJid', first: { $min: '$createdAt' }, last: { $max: '$createdAt' } } },
    {
      $group: {
        _id: null,
        unique: { $sum: { $cond: [{ $gte: ['$last', since] }, 1, 0] } },
        newContacts: { $sum: { $cond: [{ $gte: ['$first', since] }, 1, 0] } },
      },
    },
  ]).allowDiskUse(true);
  return {
    unique: r?.unique || 0,
    new: r?.newContacts || 0,
    // With a 90-day TTL, "new" means "no inbound in the retained history before this range".
    newBasis: `first inbound within the last ${RETENTION_DAYS} days of history`,
  };
}

async function conversationRows(match) {
  const rows = await MessageLog.find({ ...match, isGroup: { $ne: true }, waJid: { $type: 'string' } })
    .select('sessionId locationId waJid direction source createdAt -_id')
    .sort({ createdAt: -1 })
    .limit(ROW_CAP + 1)
    .lean();
  const truncated = rows.length > ROW_CAP;
  if (truncated) rows.length = ROW_CAP;
  return {
    rows,
    sample: {
      rows: rows.length,
      cap: ROW_CAP,
      truncated,
      // When truncated, reply rate and response time cover only the most recent ROW_CAP messages.
      coversFrom: truncated && rows.length ? rows[rows.length - 1].createdAt : null,
    },
  };
}

class AnalyticsService {
  async location(locationId, query) {
    const q = parseQuery(query);
    return cached(`loc|${locationId}|${q.range}|${q.tz}|${q.sessionId || ''}`, () => this._location(locationId, q));
  }

  async _location(locationId, { range, days, tz, sessionId }) {
    const { since, until, keys } = rangeWindow(days, tz);
    const match = { locationId, createdAt: { $gte: since } };
    if (sessionId) match.sessionId = sessionId;

    const [[f], contacts, conv, sessions] = await Promise.all([
      MessageLog.aggregate([{ $match: match }, { $facet: facetStages(tz, { perLocation: false }) }]).allowDiskUse(true),
      contactCounts(match, since),
      conversationRows(match),
      WaSession.find({ locationId }).select('label phoneNumber waName status isDefault').lean(),
    ]);

    const shaped = shapeFacets(f, keys);
    const analysis = analyzeConversations(conv.rows, { tz, groupBy: (r) => [`s:${r.sessionId}`] });

    const perSession = new Map();
    for (const r of f.bySession) {
      const c = perSession.get(r._id.id) || emptyCounts();
      addCount(c, r._id.d, r._id.s, r.n);
      perSession.set(r._id.id, c);
    }
    const sessionById = new Map(sessions.map((s) => [String(s._id), s]));
    const ids = new Set([...perSession.keys(), ...(sessionId ? [sessionId] : sessions.map((s) => String(s._id)))]);
    const numbers = [...ids]
      .map((id) => {
        const s = sessionById.get(id);
        const conv1 = analysis.byGroup[`s:${id}`];
        return {
          sessionId: id,
          label: s?.label || s?.waName || '',
          phoneNumber: s?.phoneNumber || null,
          status: s?.status || 'removed',
          isDefault: !!s?.isDefault,
          ...countsOut(perSession.get(id) || emptyCounts()),
          replyRate: conv1?.replies.rate ?? null,
          medianResponseMs: conv1?.responseTime.medianMs ?? null,
        };
      })
      .sort((a, b) => b.inbound + b.outbound - (a.inbound + a.outbound));

    const { counts, ...rest } = shaped; // eslint-disable-line no-unused-vars
    return {
      scope: 'location',
      locationId,
      sessionId,
      range,
      tz,
      from: since,
      to: until,
      ...rest,
      rates: { ...rest.rates, reply: analysis.overall.replies.rate },
      replies: analysis.overall.replies,
      responseTime: analysis.overall.responseTime,
      contacts,
      numbers,
      sample: conv.sample,
      generatedAt: new Date(),
    };
  }

  async agency(companyId, query) {
    const q = parseQuery({ ...query, sessionId: undefined });
    return cached(`co|${companyId}|${q.range}|${q.tz}`, () => this._agency(companyId, q));
  }

  async _agency(companyId, { range, days, tz }) {
    const { since, until, keys } = rangeWindow(days, tz);
    const match = { companyId, createdAt: { $gte: since } };

    const [[f], contacts, conv] = await Promise.all([
      MessageLog.aggregate([{ $match: match }, { $facet: facetStages(tz, { perLocation: true }) }]).allowDiskUse(true),
      contactCounts(match, since),
      conversationRows(match),
    ]);

    const shaped = shapeFacets(f, keys);
    const analysis = analyzeConversations(conv.rows, { tz, groupBy: (r) => [`l:${r.locationId}`] });

    const perLoc = new Map();
    for (const r of f.byLocation) {
      const c = perLoc.get(r._id.l) || emptyCounts();
      addCount(c, r._id.d, r._id.s, r.n);
      perLoc.set(r._id.l, c);
    }
    const subAccounts = [...perLoc.entries()]
      .map(([locationId, c]) => {
        const a = analysis.byGroup[`l:${locationId}`];
        return {
          locationId,
          ...countsOut(c),
          replyRate: a?.replies.rate ?? null,
          conversations: a?.replies.conversations ?? 0,
          medianResponseMs: a?.responseTime.medianMs ?? null,
          p90ResponseMs: a?.responseTime.p90Ms ?? null,
          responseSamples: a?.responseTime.samples ?? 0,
          unanswered: a?.responseTime.unanswered ?? 0,
        };
      })
      .sort((a, b) => b.inbound + b.outbound - (a.inbound + a.outbound));

    const { counts, ...rest } = shaped; // eslint-disable-line no-unused-vars
    return {
      scope: 'agency',
      companyId,
      range,
      tz,
      from: since,
      to: until,
      ...rest,
      rates: { ...rest.rates, reply: analysis.overall.replies.rate },
      replies: analysis.overall.replies,
      responseTime: analysis.overall.responseTime,
      contacts,
      subAccounts,
      sample: conv.sample,
      generatedAt: new Date(),
    };
  }
}

module.exports = { AnalyticsService, normalizeReason, parseQuery, ROW_CAP };
