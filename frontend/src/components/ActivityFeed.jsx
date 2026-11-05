import { useCallback, useEffect, useState } from 'react';
import { loc } from '../lib/api';
import { formatPhone, timeAgo } from '../lib/format';
import { Button, EmptyState, Pill, Skeleton } from './ui';
import { Icon } from './icons';

const SOURCE = { contact: 'Customer', ghl: 'From CRM', workflow: 'Workflow', phone: 'Sent from phone' };
const STATUS_TONE = { read: 'ok', delivered: 'ok', sent: 'neutral', pending: 'info', failed: 'err' };
const STATUS_LABEL = { read: 'Read', delivered: 'Delivered', sent: 'Sent', pending: 'Sending', failed: 'Failed' };

export default function ActivityFeed({ locationId, numbers = [], limit = 30, refreshKey }) {
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const label = (id) => {
    const n = numbers.find((x) => x.id === id);
    return n ? n.label || formatPhone(n.phoneNumber) : '';
  };

  const load = useCallback(async () => {
    try {
      const r = await loc(locationId).activity({ limit });
      setRows(r);
      setMore(r.length === limit);
    } catch {
      setRows([]);
    }
  }, [locationId, limit]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await loc(locationId).activity({ limit, before: rows[rows.length - 1].at });
      setRows((x) => [...x, ...r]);
      setMore(r.length === limit);
    } finally {
      setLoadingMore(false);
    }
  };

  if (!rows) {
    return (
      <div className="lc-feed-sk" aria-busy="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="row lc-feed-sk-row">
            <Skeleton h={34} w={34} r={10} />
            <div className="grow stack" style={{ gap: 7 }}>
              <Skeleton h={11} w="28%" />
              <Skeleton h={13} w={`${70 - i * 8}%`} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (!rows.length) {
    return (
      <EmptyState icon="message" title="No messages yet" flat>
        Messages sent and received on linked numbers show up here, with delivery status straight from WhatsApp.
      </EmptyState>
    );
  }

  const groups = [];
  for (const r of rows) {
    const day = dayLabel(r.at);
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1].items.push(r);
  }

  return (
    <div className="feed lc-feed">
      {groups.map((g) => (
        <div key={g.day} className="lc-feed-group">
          <div className="lc-feed-day">
            <span>{g.day}</span>
          </div>
          {g.items.map((r) => {
            const failed = r.status === 'failed';
            const dir = failed ? 'fail' : r.direction === 'inbound' ? 'in' : 'out';
            const via = label(r.sessionId);
            return (
              <div key={r.id} className={`feed-item lc-fi ${dir}`}>
                <div className={`dir ${dir}`}>
                  <Icon name={failed ? 'alert' : r.direction === 'inbound' ? 'arrowIn' : 'arrowOut'} size={15} />
                </div>
                <div className="grow lc-fi-body">
                  <div className="lc-fi-top">
                    <span className="lc-fi-who">{SOURCE[r.source] || r.source}</span>
                    {r.phone && <span className="lc-fi-phone tnum">{formatPhone(r.phone)}</span>}
                    {via && (
                      <span className="lc-fi-via">
                        <Icon name="phone" size={11} />
                        {via}
                      </span>
                    )}
                    <span className="lc-fi-time" title={r.at ? new Date(r.at).toLocaleString() : undefined}>
                      {timeAgo(r.at)}
                    </span>
                  </div>
                  <div className="msg">{r.preview || <span className="muted">[{r.kind}]</span>}</div>
                  {r.error && (
                    <div className="lc-fi-err">
                      <Icon name="alert" size={12} />
                      {r.error}
                    </div>
                  )}
                </div>
                {r.direction === 'outbound' && (
                  <Pill tone={STATUS_TONE[r.status] || 'neutral'} dot={r.status === 'read' || r.status === 'delivered'}>
                    {STATUS_LABEL[r.status] || r.status}
                  </Pill>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {more && (
        <div className="lc-feed-more">
          <Button size="sm" variant="secondary" icon="refresh" loading={loadingMore} onClick={loadMore}>
            Load older messages
          </Button>
        </div>
      )}
    </div>
  );
}

function dayLabel(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: diff < 7 ? 'long' : undefined, day: 'numeric', month: 'short' });
}
