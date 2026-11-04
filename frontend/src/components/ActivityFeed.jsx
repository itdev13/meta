import { useCallback, useEffect, useState } from 'react';
import { loc } from '../lib/api';
import { formatPhone, timeAgo } from '../lib/format';
import { Button, Empty, Pill, Skeleton } from './ui';
import { Icon } from './icons';

const SOURCE = { contact: 'Customer', ghl: 'From CRM', workflow: 'Workflow', phone: 'Sent from phone' };
const STATUS_TONE = { read: 'ok', delivered: 'ok', sent: 'neutral', pending: 'info', failed: 'err' };

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
      <div className="stack" style={{ padding: 18 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="row">
            <Skeleton h={30} w={30} r={9} />
            <div className="grow stack" style={{ gap: 6 }}>
              <Skeleton h={12} w="60%" />
              <Skeleton h={10} w="30%" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (!rows.length) {
    return (
      <Empty icon="message" title="No messages yet">
        Messages sent and received on linked numbers show up here.
      </Empty>
    );
  }

  return (
    <div className="feed">
      {rows.map((r) => {
        const failed = r.status === 'failed';
        return (
          <div key={r.id} className="feed-item">
            <div className={`dir ${failed ? 'fail' : r.direction === 'inbound' ? 'in' : 'out'}`}>
              <Icon name={failed ? 'alert' : r.direction === 'inbound' ? 'arrowIn' : 'arrowOut'} size={15} />
            </div>
            <div className="grow">
              <div className="msg">{r.preview || <span className="muted">[{r.kind}]</span>}</div>
              <div className="sub">
                <span>{SOURCE[r.source] || r.source}</span>
                {r.phone && <span className="mono">{formatPhone(r.phone)}</span>}
                {label(r.sessionId) && <span>via {label(r.sessionId)}</span>}
                <span>{timeAgo(r.at)}</span>
                {r.error && <span style={{ color: 'var(--err)' }}>{r.error}</span>}
              </div>
            </div>
            {r.direction === 'outbound' && (
              <Pill tone={STATUS_TONE[r.status] || 'neutral'}>{r.status}</Pill>
            )}
          </div>
        );
      })}
      {more && (
        <div style={{ padding: 12, textAlign: 'center', borderTop: '1px solid var(--line-2)' }}>
          <Button size="sm" variant="ghost" loading={loadingMore} onClick={loadMore}>
            Load older
          </Button>
        </div>
      )}
    </div>
  );
}
