import { useMemo, useState } from 'react';
import { Avatar, Banner, Button, Empty, Pill, Segmented } from '../../components/ui';
import { Icon } from '../../components/icons';
import { KpiStat, Meter, TimeSeriesChart } from '../../components/charts';
import { analytics, fmtDay, fmtDuration, fmtInt, fmtPct } from '../../lib/api-analytics';
import { timeAgo } from '../../lib/format';
import {
  AnalyticsSkeleton,
  CardHead,
  FAIL_STRIP,
  RANGE_WORDS,
  RANGES,
  SampleNote,
  VOLUME_SERIES,
  rateTone,
  useAnalytics,
} from '../location/AnalyticsPanel';

// "Needs attention" thresholds — tuned to avoid flagging tiny samples.
const FAIL_RATE_FLAG = 0.1; // ≥10% of settled outbound failed…
const FAIL_MIN = 5; // …and at least 5 failures
const SLOW_MS = 2 * 60 * 60 * 1000; // median first response over 2h…
const SLOW_MIN_SAMPLES = 5; // …across at least 5 answered chats
const LOW_DELIVERY = 0.8;
const LOW_DELIVERY_MIN = 20;

const SORTS = [
  { value: 'volume', label: 'Volume' },
  { value: 'reply', label: 'Reply rate' },
  { value: 'failed', label: 'Failures' },
];

function sorter(key) {
  const nullLast = (a, b) => (a == null) - (b == null);
  if (key === 'reply') return (a, b) => nullLast(a.replyRate, b.replyRate) || (b.replyRate ?? 0) - (a.replyRate ?? 0) || b.volume - a.volume;
  if (key === 'failed') return (a, b) => b.failed - a.failed || (b.failRate ?? 0) - (a.failRate ?? 0);
  return (a, b) => b.volume - a.volume;
}

function issuesFor(r, sub) {
  const out = [];
  if (r.failedOutbound >= FAIL_MIN && (r.failRate ?? 0) >= FAIL_RATE_FLAG) out.push({ tone: 'err', icon: 'alert', text: `${fmtPct(r.failRate)} of sends failed` });
  if (r.deliveryRate != null && r.outbound >= LOW_DELIVERY_MIN && r.deliveryRate < LOW_DELIVERY) out.push({ tone: 'warn', icon: 'send', text: `Only ${fmtPct(r.deliveryRate)} delivered` });
  if (r.medianResponseMs != null && r.responseSamples >= SLOW_MIN_SAMPLES && r.medianResponseMs >= SLOW_MS) out.push({ tone: 'warn', icon: 'bolt', text: `Slow replies · ${fmtDuration(r.medianResponseMs)} median` });
  if (r.unanswered >= 10) out.push({ tone: 'warn', icon: 'inbox', text: `${fmtInt(r.unanswered)} chats unanswered 24h+` });
  if (sub?.attention) out.push({ tone: 'err', icon: 'unlink', text: `${sub.attention} number${sub.attention === 1 ? '' : 's'} disconnected` });
  return out;
}

/** Agency analytics. Props: subAccounts (overview rows: id, name, logoUrl, numbers, connected, attention…), onOpen(locationId). */
export default function AgencyAnalytics({ subAccounts = [], onOpen }) {
  const [range, setRange] = useState('30d');
  const [sort, setSort] = useState('volume');
  const { data, loading, error, reload } = useAnalytics(() => analytics.agency({ range }), [range]);

  const subById = useMemo(() => new Map(subAccounts.map((s) => [s.id, s])), [subAccounts]);

  const rows = useMemo(() => {
    if (!data) return [];
    const seen = new Set();
    const list = data.subAccounts.map((r) => {
      seen.add(r.locationId);
      return { ...r, volume: r.inbound + r.outbound, sub: subById.get(r.locationId) };
    });
    // Sub-accounts with a linked number but no traffic still belong on the board (quiet is a signal).
    for (const s of subAccounts) {
      if (seen.has(s.id) || !s.numbers?.length) continue;
      list.push({ locationId: s.id, inbound: 0, outbound: 0, delivered: 0, read: 0, failed: 0, failedOutbound: 0, deliveryRate: null, readRate: null, failRate: null, replyRate: null, medianResponseMs: null, responseSamples: 0, unanswered: 0, volume: 0, sub: s });
    }
    return list;
  }, [data, subAccounts, subById]);

  const sorted = useMemo(() => [...rows].sort(sorter(sort)), [rows, sort]);
  const maxVolume = Math.max(1, ...rows.map((r) => r.volume));
  const attention = useMemo(
    () =>
      rows
        .map((r) => ({ r, issues: issuesFor(r, r.sub) }))
        .filter((x) => x.issues.length)
        .sort((a, b) => b.issues.filter((i) => i.tone === 'err').length - a.issues.filter((i) => i.tone === 'err').length || b.r.volume - a.r.volume)
        .slice(0, 8),
    [rows],
  );

  const nameOf = (id) => subById.get(id)?.name || `Sub-account ${id.slice(0, 6)}…`;

  const head = (
    <div className="page-head">
      <div>
        <h1>Agency analytics</h1>
        <p>WhatsApp performance across every sub-account: volume, delivery, reply rates and response times — and who needs a hand.</p>
      </div>
    </div>
  );

  const controls = (
    <div className="an-controls">
      <Segmented value={range} onChange={setRange} options={RANGES} />
      <div className="grow" />
      {data && <span className="an-updated">{loading ? 'Updating…' : `Updated ${timeAgo(data.generatedAt)}`}</span>}
      <Button variant="ghost" size="sm" icon="refresh" onClick={reload} disabled={loading}>
        Refresh
      </Button>
    </div>
  );

  if (!data && loading) {
    return (
      <>
        {head}
        {controls}
        <AnalyticsSkeleton />
      </>
    );
  }
  if (!data && error) {
    return (
      <>
        {head}
        {controls}
        <div className="card">
          <Empty icon="alert" title="Couldn’t load analytics" action={<Button onClick={reload} icon="refresh">Try again</Button>}>
            {error.message}
          </Empty>
        </div>
      </>
    );
  }

  const { totals, rates, replies, responseTime } = data;
  const words = RANGE_WORDS[data.range];
  const active = data.subAccounts.filter((r) => r.inbound + r.outbound > 0).length;
  const isEmpty = totals.inbound + totals.outbound === 0;

  return (
    <>
      {head}
      {controls}
      <div className={`an-wrap ${loading ? 'an-refreshing' : ''}`} aria-busy={loading}>
        {error && (
          <Banner tone="err" icon="alert" title="Couldn’t refresh — showing the last loaded figures">
            {error.message}
          </Banner>
        )}

        {isEmpty ? (
          <div className="card">
            <Empty icon="inbox" title={`No WhatsApp messages across your sub-accounts in the ${words}`}>
              Once sub-accounts link numbers and start messaging, agency-wide volume, delivery and response times appear here.
            </Empty>
          </div>
        ) : (
          <>
            <SampleNote sample={data.sample} />
            <div className="an-kpis">
              <KpiStat label="Messages in" icon="arrowIn" value={fmtInt(totals.inbound)} spark={data.series.map((d) => d.inbound)} sub={`${fmtInt(data.contacts.unique)} contacts · ${fmtInt(data.contacts.new)} new`} />
              <KpiStat label="Messages out" icon="arrowOut" value={fmtInt(totals.outbound)} spark={data.series.map((d) => d.outbound)} sub={totals.failedOutbound ? `${fmtInt(totals.failedOutbound)} failed` : 'None failed'} tone={totals.failedOutbound ? 'warn' : ''} />
              <KpiStat label="Delivery rate" icon="check" value={fmtPct(rates.delivery)} sub={<Meter value={rates.delivery} tone={rateTone(rates.delivery)} label="Delivery rate" />} />
              <KpiStat label="Reply rate" icon="users" value={fmtPct(rates.reply)} sub={`${fmtInt(replies.replied)} of ${fmtInt(replies.conversations - replies.pending)} conversations`} />
              <KpiStat label="First response" icon="bolt" value={fmtDuration(responseTime.medianMs)} unit={responseTime.medianMs != null ? 'median' : null} sub={responseTime.p90Ms != null ? `90% within ${fmtDuration(responseTime.p90Ms)}` : 'No team replies yet'} />
              <KpiStat label="Active sub-accounts" icon="building" value={fmtInt(active)} unit={`/ ${fmtInt(Math.max(active, subAccounts.length))}`} sub="Sent or received a message" />
            </div>

            <section className="card an-card">
              <CardHead title="Message volume" icon="message" sub={`All sub-accounts, per day, ${words}. Failed messages on their own scale underneath.`} />
              <TimeSeriesChart data={data.series} series={VOLUME_SERIES} strip={FAIL_STRIP} formatX={fmtDay} title="Agency messages received and sent per day" />
            </section>

            {attention.length > 0 && (
              <section className="card an-card">
                <CardHead title="Needs attention" icon="alert" sub="Sub-accounts with failing sends, poor delivery, slow replies or disconnected numbers" right={<Pill tone="warn">{attention.length}</Pill>} />
                <ul className="an-attention">
                  {attention.map(({ r, issues }) => (
                    <li key={r.locationId}>
                      <button type="button" onClick={() => onOpen?.(r.locationId)}>
                        <Avatar name={nameOf(r.locationId)} src={r.sub?.logoUrl} />
                        <div className="grow">
                          <div className="name">{nameOf(r.locationId)}</div>
                          <div className="issues">
                            {issues.map((i) => (
                              <Pill key={i.text} tone={i.tone}>
                                <Icon name={i.icon} size={12} />
                                {i.text}
                              </Pill>
                            ))}
                          </div>
                        </div>
                        <Icon name="chevron" size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="card an-card an-flush">
              <CardHead title="Sub-account leaderboard" icon="building" sub="Click a sub-account to manage it" right={<Segmented value={sort} onChange={setSort} options={SORTS} />} />
              <div className="table-wrap">
                <table className="table an-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>#</th>
                      <th>Sub-account</th>
                      <th className="num" aria-sort={sort === 'volume' ? 'descending' : undefined}>Messages</th>
                      <th className="num">Delivery</th>
                      <th className="num" aria-sort={sort === 'reply' ? 'descending' : undefined}>Reply rate</th>
                      <th className="num">Median response</th>
                      <th className="num" aria-sort={sort === 'failed' ? 'descending' : undefined}>Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r, i) => (
                      <tr key={r.locationId} onClick={() => onOpen?.(r.locationId)} onKeyDown={(e) => e.key === 'Enter' && onOpen?.(r.locationId)} tabIndex={0} style={{ cursor: 'pointer' }}>
                        <td className="muted tnum">{i + 1}</td>
                        <td>
                          <div className="row">
                            <Avatar name={nameOf(r.locationId)} src={r.sub?.logoUrl} />
                            <div className="an-num-cell">
                              <span className="name">{nameOf(r.locationId)}</span>
                              <span className="sub">
                                {r.sub ? `${r.sub.connected || 0} of ${r.sub.numbers?.length || 0} numbers connected` : 'Not in directory'}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="num">
                          <div className="an-vol">
                            <span>{fmtInt(r.volume)}</span>
                            <div className="an-vol-track" title={`${fmtInt(r.inbound)} received · ${fmtInt(r.outbound)} sent`}>
                              <i style={{ width: `${(r.inbound / maxVolume) * 100}%`, background: 'var(--viz-in)' }} />
                              <i style={{ width: `${(r.outbound / maxVolume) * 100}%`, background: 'var(--viz-out)' }} />
                            </div>
                          </div>
                        </td>
                        <td className="num">{fmtPct(r.deliveryRate)}</td>
                        <td className="num">{fmtPct(r.replyRate)}</td>
                        <td className="num">{fmtDuration(r.medianResponseMs)}</td>
                        <td className={`num ${r.failed ? 'an-bad' : ''}`}>{fmtInt(r.failed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="an-table-foot">
                <span className="viz-key rect" style={{ '--c': 'var(--viz-in)' }} /> Received
                <span className="viz-key rect" style={{ '--c': 'var(--viz-out)' }} /> Sent
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
