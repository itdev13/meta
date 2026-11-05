import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, EmptyState, PageHeader, Pill, Segmented, Skeleton, SyncMeta } from '../../components/ui';
import { Icon } from '../../components/icons';
import { BarList, KpiStat, Meter, SegmentedBar, TimeSeriesChart, Heatmap } from '../../components/charts';
import { analytics, fmtDay, fmtDuration, fmtInt, fmtPct } from '../../lib/api-analytics';
import { formatPhone, statusMeta, timeAgo } from '../../lib/format';

export const RANGES = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

/** Fixed order = fixed color (identity follows the source, never its rank). */
export const SOURCES = [
  { key: 'ghl', label: 'CRM agents', color: 'var(--viz-src-1)' },
  { key: 'workflow', label: 'Workflows', color: 'var(--viz-src-2)' },
  { key: 'auto', label: 'Auto-replies', color: 'var(--viz-src-3)' },
  { key: 'phone', label: 'Sent from phone', color: 'var(--viz-src-4)' },
];

export const VOLUME_SERIES = [
  { key: 'inbound', label: 'Received', color: 'var(--viz-in)' },
  { key: 'outbound', label: 'Sent', color: 'var(--viz-out)' },
];
export const FAIL_STRIP = { key: 'failed', label: 'Failed', color: 'var(--viz-fail)' };

export const RANGE_WORDS = { '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days' };

export function rateTone(r, { good = 0.9, warn = 0.75 } = {}) {
  if (r == null) return 'neutral';
  return r >= good ? 'ok' : r >= warn ? 'warn' : 'err';
}

/** Fetch with "refetch keeps the frame": the previous data stays (dimmed) while the next loads. */
export function useAnalytics(fetcher, deps) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = (seq.current += 1);
    setLoading(true);
    setError(null);
    fetcher()
      .then((d) => n === seq.current && setData(d))
      .catch((e) => n === seq.current && setError(e))
      .finally(() => n === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(load, [load]);
  return { data, loading, error, reload: load };
}

export function AnalyticsSkeleton() {
  return (
    <div className="an-wrap">
      <div className="an-kpis">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="card kpi">
            <Skeleton h={12} w="50%" />
            <div style={{ height: 10 }} />
            <Skeleton h={28} w="65%" />
            <div style={{ height: 8 }} />
            <Skeleton h={10} w="80%" />
          </div>
        ))}
      </div>
      <div className="card an-card">
        <Skeleton h={14} w={160} />
        <div style={{ height: 18 }} />
        <Skeleton h={240} r={12} />
      </div>
      <div className="an-grid-2">
        <div className="card an-card">
          <Skeleton h={14} w={140} />
          <div style={{ height: 18 }} />
          <Skeleton h={120} r={12} />
        </div>
        <div className="card an-card">
          <Skeleton h={14} w={140} />
          <div style={{ height: 18 }} />
          <Skeleton h={120} r={12} />
        </div>
      </div>
    </div>
  );
}

export function CardHead({ title, sub, right, icon }) {
  return (
    <div className="an-card-head">
      <div className="grow">
        <h3>
          {icon && <Icon name={icon} size={15} />}
          {title}
        </h3>
        {sub && <p>{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function SampleNote({ sample }) {
  if (!sample?.truncated) return null;
  return (
    <Banner tone="info" icon="info" title="Reply rate and response times use your most recent messages">
      This period has more than {fmtInt(sample.cap)} messages, so those two figures cover activity since {new Date(sample.coversFrom).toLocaleDateString()}. Every
      other number covers the full period.
    </Banner>
  );
}

function numberName(n) {
  return n.label || n.waName || (n.phoneNumber ? formatPhone(n.phoneNumber) : 'Unnamed number');
}

/** Sub-account analytics. Props: locationId, numbers (from the overview). */
export default function AnalyticsPanel({ locationId, numbers = [], onGoNumbers }) {
  const [range, setRange] = useState('30d');
  const [sessionId, setSessionId] = useState('');
  const { data, loading, error, reload } = useAnalytics(() => analytics.location(locationId, { range, sessionId }), [locationId, range, sessionId]);

  const sparkIn = useMemo(() => data?.series.map((d) => d.inbound) || [], [data]);
  const sparkOut = useMemo(() => data?.series.map((d) => d.outbound) || [], [data]);

  const head = (
    <PageHeader
      eyebrow="Performance"
      title="Analytics"
      description="How your WhatsApp numbers perform: messages in and out, delivery, replies and how fast your team responds."
      actions={
        <div className="an-controls">
          {numbers.length > 1 && (
            <label className="an-select">
              <Icon name="phone" size={14} />
              <select className="select" value={sessionId} onChange={(e) => setSessionId(e.target.value)} aria-label="Filter by number">
                <option value="">All numbers</option>
                {numbers.map((n) => (
                  <option key={n.id} value={n.id}>
                    {numberName(n)}
                    {n.label && n.phoneNumber ? ` · ${formatPhone(n.phoneNumber)}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Segmented value={range} onChange={setRange} options={RANGES} />
        </div>
      }
      meta={<SyncMeta at={data?.generatedAt} loading={loading} onRefresh={reload} />}
    />
  );

  if (!data && loading) {
    return (
      <div className="lc-an">
        {head}
        <AnalyticsSkeleton />
      </div>
    );
  }

  if (!data && error) {
    return (
      <div className="lc-an">
        {head}
        <EmptyState icon="alert" tone="err" title="Couldn’t load analytics" action={<Button onClick={reload} icon="refresh">Try again</Button>}>
          {error.message}
        </EmptyState>
      </div>
    );
  }

  const { totals, rates, replies, responseTime, contacts } = data;
  const isEmpty = totals.inbound + totals.outbound === 0;
  const words = RANGE_WORDS[data.range];

  return (
    <div className="lc-an">
      {head}
      <div className={`an-wrap ${loading ? 'an-refreshing' : ''}`} aria-busy={loading}>
        {error && (
          <Banner tone="err" icon="alert" title="Couldn’t refresh — showing the last loaded figures">
            {error.message}
          </Banner>
        )}

        {isEmpty ? (
          <AnalyticsGhost
            title={`No messages in the ${words}`}
            action={
              numbers.length === 0 && onGoNumbers ? (
                <Button variant="primary" icon="qr" onClick={onGoNumbers}>
                  Link a number
                </Button>
              ) : null
            }
          >
            Once your linked numbers send or receive WhatsApp messages, volume, delivery, reply rate and response times show up here.
            {numbers.length === 0 && ' Start by linking a number on the Numbers tab.'}
          </AnalyticsGhost>
        ) : (
          <>
            <SampleNote sample={data.sample} />

            <div className="an-kpis">
              <KpiStat accent="info" label="Messages in" icon="arrowIn" value={fmtInt(totals.inbound)} spark={sparkIn} sub={`${fmtInt(contacts.unique)} contacts · ${fmtInt(contacts.new)} new`} />
              <KpiStat accent="brand" label="Messages out" icon="arrowOut" value={fmtInt(totals.outbound)} spark={sparkOut} sub={totals.failedOutbound ? `${fmtInt(totals.failedOutbound)} failed` : 'None failed'} tone={totals.failedOutbound ? 'warn' : ''} />
              <KpiStat accent="teal" label="Delivery rate" icon="check" value={fmtPct(rates.delivery)} sub={<Meter value={rates.delivery} tone={rateTone(rates.delivery)} label="Delivery rate" />} />
              <KpiStat accent="teal" label="Read rate" icon="message" value={fmtPct(rates.read)} sub={<Meter value={rates.read} tone="ok" label="Read rate" />} />
              <KpiStat
                accent="violet"
                label="Reply rate"
                icon="users"
                value={fmtPct(rates.reply)}
                sub={replies.conversations ? `${fmtInt(replies.replied)} of ${fmtInt(replies.conversations - replies.pending)} conversations` : 'No outbound conversations'}
              />
              <KpiStat
                accent="amber"
                label="First response"
                icon="clock"
                value={fmtDuration(responseTime.medianMs)}
                unit={responseTime.medianMs != null ? 'median' : null}
                sub={responseTime.p90Ms != null ? `90% within ${fmtDuration(responseTime.p90Ms)}` : 'No replies from your team yet'}
              />
            </div>

            <section className="card an-card">
              <CardHead
                title="Message volume"
                icon="message"
                sub={`Messages received and sent per day, ${words}. Failed messages are shown on their own scale underneath.`}
              />
              <TimeSeriesChart
                data={data.series}
                series={VOLUME_SERIES}
                strip={FAIL_STRIP}
                formatX={fmtDay}
                title="Messages received and sent per day"
              />
            </section>

            <div className="an-grid-2">
              <section className="card an-card">
                <CardHead title="Who sends your messages" icon="send" sub={`${fmtInt(totals.outbound)} outbound messages by source`} />
                <SegmentedBar parts={SOURCES.map((s) => ({ ...s, value: totals.outboundBySource[s.key] || 0 }))} label="Outbound messages by source" />
              </section>

              <section className="card an-card">
                <CardHead title="Responsiveness" icon="bolt" sub="How quickly someone answers a waiting customer (within 24h)" />
                <dl className="an-facts">
                  <div>
                    <dt>Median · team</dt>
                    <dd>{fmtDuration(responseTime.medianMs)}</dd>
                    <span>CRM agents and phone replies</span>
                  </div>
                  <div>
                    <dt>Median · incl. automations</dt>
                    <dd>{fmtDuration(responseTime.all.medianMs)}</dd>
                    <span>Counts workflows and auto-replies</span>
                  </div>
                  <div>
                    <dt>90th percentile</dt>
                    <dd>{fmtDuration(responseTime.p90Ms)}</dd>
                    <span>{fmtInt(responseTime.samples)} answered chats</span>
                  </div>
                  <div className={responseTime.unanswered ? 'warn' : ''}>
                    <dt>Unanswered 24h+</dt>
                    <dd>{fmtInt(responseTime.unanswered)}</dd>
                    <span>{responseTime.open ? `${fmtInt(responseTime.open)} waiting right now` : 'Nobody waiting now'}</span>
                  </div>
                </dl>
              </section>
            </div>

            {data.numbers.length > 0 && !sessionId && (
              <section className="card an-card an-flush">
                <CardHead title="By number" icon="phone" sub="Click a number to filter the whole page to it" />
                <div className="table-wrap">
                  <table className="table an-table">
                    <thead>
                      <tr>
                        <th>Number</th>
                        <th className="num">Received</th>
                        <th className="num">Sent</th>
                        <th className="num">Delivery</th>
                        <th className="num">Reply rate</th>
                        <th className="num">Median response</th>
                        <th className="num">Failed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.numbers.map((n) => {
                        const sm = statusMeta(n.status);
                        const linked = numbers.some((x) => x.id === n.sessionId);
                        return (
                          <tr
                            key={n.sessionId}
                            onClick={linked ? () => setSessionId(n.sessionId) : undefined}
                            onKeyDown={(e) => linked && e.key === 'Enter' && setSessionId(n.sessionId)}
                            tabIndex={linked ? 0 : undefined}
                            style={{ cursor: linked ? 'pointer' : 'default' }}
                          >
                            <td>
                              <div className="an-num-cell">
                                <span className="name">{n.label || (n.phoneNumber ? formatPhone(n.phoneNumber) : 'Removed number')}</span>
                                <span className="sub">
                                  {n.label && n.phoneNumber ? formatPhone(n.phoneNumber) : ''}
                                  <Pill tone={n.status === 'removed' ? 'neutral' : sm.tone} dot>
                                    {n.status === 'removed' ? 'Removed' : sm.label}
                                  </Pill>
                                </span>
                              </div>
                            </td>
                            <td className="num">{fmtInt(n.inbound)}</td>
                            <td className="num">{fmtInt(n.outbound)}</td>
                            <td className="num">{fmtPct(n.deliveryRate)}</td>
                            <td className="num">{fmtPct(n.replyRate)}</td>
                            <td className="num">{fmtDuration(n.medianResponseMs)}</td>
                            <td className={`num ${n.failed ? 'an-bad' : ''}`}>{fmtInt(n.failed)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="card an-card">
              <CardHead
                title="Busiest hours"
                icon="inbox"
                sub={`When customers message you (${data.tz.replace(/_/g, ' ')} time) — useful for staffing and business hours`}
              />
              {data.heatmap.max ? <Heatmap cells={data.heatmap.cells} max={data.heatmap.max} unit="messages received" /> : <div className="viz-empty">No incoming messages in this period.</div>}
            </section>

            <div className="an-grid-2">
              <section className="card an-card">
                <CardHead title="Top keywords" icon="zap" sub="Incoming messages that matched a keyword rule" />
                <BarList items={data.keywords.map((k) => ({ key: k.keyword, label: k.keyword, value: k.count }))} emptyText="No keyword rules matched in this period." label="Top keywords" />
              </section>
              <section className="card an-card">
                <CardHead
                  title="Failure reasons"
                  icon="alert"
                  sub={totals.failed ? `${fmtInt(totals.failed)} failed (${fmtInt(totals.failedOutbound)} sending, ${fmtInt(totals.failedInbound)} syncing to the CRM)` : 'Nothing failed in this period'}
                />
                <BarList
                  items={data.failures.map((f) => ({ key: f.reason, label: f.reason, sub: `last ${timeAgo(f.lastAt)}`, value: f.count }))}
                  color="var(--viz-fail)"
                  emptyText="No failures — every message went through."
                  label="Failure reasons"
                />
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const GHOST_KPIS = [
  ['Messages in', 'arrowIn', 'info'],
  ['Messages out', 'arrowOut', 'brand'],
  ['Delivery rate', 'check', 'teal'],
  ['Read rate', 'message', 'teal'],
  ['Reply rate', 'users', 'violet'],
  ['First response', 'clock', 'amber'],
];
// A soft, believable silhouette for the preview chart (not data).
const GHOST_IN = [8, 11, 9, 14, 12, 17, 15, 19, 16, 22, 20, 24, 21, 26];
const GHOST_OUT = [5, 7, 6, 9, 10, 11, 9, 13, 12, 15, 13, 17, 16, 18];

/** Empty analytics: a dimmed preview of the real layout behind a centred message. */
export function AnalyticsGhost({ title, children, action }) {
  const w = 640;
  const h = 170;
  const max = 28;
  const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 16)).toFixed(1)}`).join('');
  return (
    <div className="lc-ghost">
      <div className="lc-ghost-preview" aria-hidden="true">
        <div className="an-kpis">
          {GHOST_KPIS.map(([k, icon, tone]) => (
            <div key={k} className={`card kpi kpi-accent-${tone}`}>
              <div className="kpi-top">
                <span className="kpi-ic">
                  <Icon name={icon} size={14} />
                </span>
                <span className="kpi-k">{k}</span>
              </div>
              <div className="kpi-row">
                <div className="kpi-v">—</div>
              </div>
              <div className="lc-ghost-line" />
            </div>
          ))}
        </div>
        <div className="card an-card lc-ghost-chart">
          <div className="lc-ghost-title">
            <span className="lc-ghost-chip" />
            <span className="lc-ghost-bar" style={{ width: 140 }} />
          </div>
          <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="lc-ghost-svg">
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <line key={f} x1="0" x2={w} y1={h - f * (h - 16)} y2={h - f * (h - 16)} />
            ))}
            <path d={`${path(GHOST_IN)}L${w},${h}L0,${h}Z`} className="a1" />
            <path d={path(GHOST_IN)} className="l1" />
            <path d={path(GHOST_OUT)} className="l2" />
          </svg>
        </div>
      </div>
      <div className="lc-ghost-msg">
        <div className="lc-ghost-msg-ic">
          <Icon name="chart" size={22} />
        </div>
        <h4>{title}</h4>
        <p>{children}</p>
        {action && <div className="lc-empty-action">{action}</div>}
      </div>
    </div>
  );
}
