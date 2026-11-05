import { useCallback, useEffect, useMemo, useState } from 'react';
import { agency } from '../../lib/api';
import { useLiveStatus } from '../../lib/live';
import { formatPhone, initials, plural, statusMeta, subscriptionLabel, timeAgo } from '../../lib/format';
import { Banner, Button, Empty, Menu, Pill, Segmented, Toggle, useAction } from '../../components/ui';
import { Icon } from '../../components/icons';
import Topbar from '../../components/Topbar';
import ConnectNumberModal from '../../components/ConnectNumberModal';
import SubAccountDrawer from './SubAccountDrawer';
import PolicyPanel from './PolicyPanel';
import AgencyAnalytics from './AgencyAnalytics';

const VIEW_KEY = 'greenline.agency.view';

function readView() {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return v === 'list' ? 'list' : 'cards';
  } catch {
    return 'cards';
  }
}

export default function AgencyApp({ user, context }) {
  const act = useAction();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('subaccounts');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [openId, setOpenId] = useState(null);
  const [linkFor, setLinkFor] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState(readView);
  const [, setTick] = useState(0);
  const isAdmin = context.isAdmin;

  const changeView = (v) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage blocked (private mode / iframe) — the choice just won't persist */
    }
  };

  // Keep "Synced 2m ago" honest without a reload.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async (refresh) => {
    try {
      setData(await agency.overview(refresh));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useLiveStatus((evt) => {
    if (['connected', 'disconnected', 'logged_out', 'banned', 'replaced', 'paused'].includes(evt.status)) load();
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.subAccounts.filter((s) => {
      if (q && !`${s.name} ${s.email} ${s.city} ${s.id} ${s.numbers.map((n) => n.phoneNumber).join(' ')}`.toLowerCase().includes(q)) return false;
      if (filter === 'enabled') return s.allowed;
      if (filter === 'disabled') return !s.allowed;
      if (filter === 'connected') return s.connected > 0;
      if (filter === 'attention') return s.attention > 0;
      if (filter === 'requests') return !!s.request;
      return true;
    });
  }, [data, query, filter]);

  if (error && !data) {
    return (
      <div className="center-screen">
        <Empty icon="alert" title="Couldn’t load your agency" action={<Button onClick={() => load()}>Try again</Button>}>
          {error}
        </Empty>
      </div>
    );
  }

  const setAccess = async (s, enabled) => {
    setData((d) => ({ ...d, subAccounts: d.subAccounts.map((x) => (x.id === s.id ? { ...x, allowed: enabled, request: enabled ? null : x.request } : x)) }));
    await act(() => agency.setAccess(s.id, { enabled }), enabled ? `WhatsApp enabled for ${s.name}` : `WhatsApp disabled for ${s.name}`);
    load();
  };

  const bulk = async (enabled) => {
    const ids = [...selected];
    await act(() => agency.bulkAccess(ids, enabled), `${enabled ? 'Enabled' : 'Disabled'} ${plural(ids.length, 'sub-account')}`);
    setSelected(new Set());
    load();
  };

  const summary = data?.summary;
  const counts = data
    ? {
        all: data.subAccounts.length,
        enabled: data.subAccounts.filter((s) => s.allowed).length,
        disabled: data.subAccounts.filter((s) => !s.allowed).length,
        connected: data.subAccounts.filter((s) => s.connected > 0).length,
        attention: data.subAccounts.filter((s) => s.attention > 0).length,
        requests: summary.pendingRequests,
      }
    : {};
  const totals = data
    ? data.subAccounts.reduce(
        (t, s) => ({ numbers: t.numbers + s.numbers.length, inbound: t.inbound + s.messages24h.inbound, outbound: t.outbound + s.messages24h.outbound }),
        { numbers: 0, inbound: 0, outbound: 0 },
      )
    : { numbers: 0, inbound: 0, outbound: 0 };
  const handlers = (s) => ({
    onSelect: () =>
      setSelected((prev) => {
        const n = new Set(prev);
        if (n.has(s.id)) n.delete(s.id);
        else n.add(s.id);
        return n;
      }),
    onOpen: () => setOpenId(s.id),
    onToggle: (v) => setAccess(s, v),
    onLink: () => setLinkFor(s),
    onDecline: async () => {
      await act(() => agency.decline(s.id), 'Request declined');
      load();
    },
  });
  const open = data?.subAccounts.find((s) => s.id === openId);
  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div className="shell">
      <Topbar
        crumb="Agency"
        tab={tab}
        onTab={setTab}
        tabs={[
          { value: 'subaccounts', label: 'Sub-accounts', icon: 'building', count: summary?.pendingRequests || null },
          { value: 'analytics', label: 'Analytics', icon: 'sliders' },
          { value: 'policy', label: 'Access & safety', icon: 'shield' },
        ]}
        right={
          <div className="row">
            <span className="muted" style={{ fontSize: 12.5 }}>
              {user.name || user.email}
            </span>
            {!isAdmin && <Pill tone="neutral">View only</Pill>}
          </div>
        }
      />
      <main className="page">
        {!data ? (
          <AgencySkeleton />
        ) : tab === 'analytics' ? (
          <AgencyAnalytics subAccounts={data.subAccounts} onOpen={(id) => setOpenId(id)} />
        ) : tab === 'policy' ? (
          <PolicyPanel settings={data.settings} isAdmin={isAdmin} counts={counts} onSaved={() => load()} />
        ) : (
          <div className="ag-page">
            <header className="ag-head">
              <div className="ag-head-text">
                <div className="ag-eyebrow">Agency console</div>
                <h1>WhatsApp across your agency</h1>
                <p>Choose who can use WhatsApp, link numbers for clients and keep every connection healthy.</p>
              </div>
              <div className="ag-head-actions">
                {data.syncedAt && (
                  <span className="ag-sync" title={new Date(data.syncedAt).toLocaleString()}>
                    <span className="ag-sync-dot" />
                    Synced {timeAgo(data.syncedAt)}
                  </span>
                )}
                <Button
                  icon="refresh"
                  loading={refreshing}
                  onClick={async () => {
                    setRefreshing(true);
                    await load(true);
                    setRefreshing(false);
                  }}
                >
                  Refresh
                </Button>
                <ViewToggle value={view} onChange={changeView} />
              </div>
            </header>

            {!data.agencyInstalled && (
              <Banner tone="info" icon="info" title="Install at the agency level to see every sub-account">
                Only sub-accounts that installed the app on their own are listed. Install from the marketplace as an agency to manage all of them
                from here.
              </Banner>
            )}

            <div className="ag-kpis">
              <Kpi
                k="WhatsApp enabled"
                v={summary.allowed}
                sub={`/ ${summary.subAccounts}`}
                icon="building"
                tone="brand"
                meter={summary.subAccounts ? summary.allowed / summary.subAccounts : 0}
                h={data.settings.accessMode === 'all' ? 'On for every sub-account by default' : 'Only sub-accounts you choose'}
              />
              <Kpi
                k="Connected numbers"
                v={summary.connectedNumbers}
                sub={totals.numbers > summary.connectedNumbers ? `/ ${totals.numbers}` : null}
                icon="phone"
                tone="teal"
                h={totals.numbers ? `Across ${plural(counts.connected, 'sub-account')}` : 'No numbers linked yet'}
              />
              <Kpi
                k="Need attention"
                v={summary.attention}
                icon="alert"
                tone={summary.attention ? 'alert' : 'calm'}
                h={summary.attention ? 'Logged out or dropped · review' : 'Every number is healthy'}
                onClick={summary.attention ? () => setFilter('attention') : null}
              />
              <Kpi
                k="Messages · 24h"
                v={summary.messages24h.toLocaleString()}
                icon="message"
                tone="info"
                h={
                  <span className="ag-io">
                    <span className="in">
                      <ArrowIn /> {totals.inbound.toLocaleString()} in
                    </span>
                    <span className="out">
                      <ArrowOut /> {totals.outbound.toLocaleString()} out
                    </span>
                  </span>
                }
              />
            </div>

            {data.notInstalled > 0 && (
              <div className="ag-note">
                <Icon name="info" size={14} />
                <span className="ag-note-body">
                  <span>
                    <b>{plural(data.notInstalled, 'sub-account')}</b> in your agency {data.notInstalled === 1 ? 'hasn’t' : 'haven’t'} installed Greenline yet
                  </span>
                  <span className="ag-note-sep" />
                  <span className="ag-note-hint">Install it from the marketplace to manage {data.notInstalled === 1 ? 'it' : 'them'} here</span>
                </span>
              </div>
            )}

            {summary.pendingRequests > 0 && filter !== 'requests' && (
              <Banner
                tone="warn"
                icon="users"
                title={`${plural(summary.pendingRequests, 'sub-account')} asked for WhatsApp`}
                action={
                  <Button size="sm" onClick={() => setFilter('requests')}>
                    Review
                  </Button>
                }
              />
            )}

            <div className="ag-toolbar">
              <div className="input-icon ag-search">
                <Icon name="search" size={15} />
                <input className="input" placeholder="Search name, email, number…" value={query} onChange={(e) => setQuery(e.target.value)} />
                {query && (
                  <button type="button" className="ag-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
                    <Icon name="x" size={13} />
                  </button>
                )}
              </div>
              <div className="ag-filters">
                <Segmented
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: 'all', label: 'All', count: counts.all },
                    { value: 'enabled', label: 'Enabled', count: counts.enabled },
                    { value: 'disabled', label: 'Disabled', count: counts.disabled },
                    { value: 'connected', label: 'Connected', count: counts.connected },
                    { value: 'attention', label: 'Attention', count: counts.attention },
                    ...(counts.requests ? [{ value: 'requests', label: 'Requests', count: counts.requests }] : []),
                  ]}
                />
              </div>
              {isAdmin && view === 'cards' && rows.length > 0 && (
                <button type="button" className="ag-selectall" onClick={() => setSelected(allVisibleSelected ? new Set() : new Set(rows.map((r) => r.id)))}>
                  {allVisibleSelected ? 'Clear selection' : 'Select all'}
                </button>
              )}
            </div>

            {rows.length === 0 ? (
              data.subAccounts.length ? (
                <AgEmpty
                  icon="search"
                  title="No sub-accounts match"
                  action={
                    <Button
                      size="sm"
                      onClick={() => {
                        setQuery('');
                        setFilter('all');
                      }}
                    >
                      Clear search &amp; filters
                    </Button>
                  }
                >
                  {query ? (
                    <>
                      Nothing matches “{query.trim()}”{filter !== 'all' ? ' with this filter' : ''}. Try a name, email, city or phone number.
                    </>
                  ) : (
                    'No sub-accounts fit this filter right now.'
                  )}
                </AgEmpty>
              ) : (
                <AgEmpty icon="building" title="No sub-accounts yet">
                  Install Greenline on a sub-account from the marketplace, then switch WhatsApp on for it here.
                </AgEmpty>
              )
            ) : view === 'cards' ? (
              <div className={`ag-grid ${selected.size ? 'selecting' : ''}`}>
                {rows.map((s) => (
                  <SubCard key={s.id} s={s} isAdmin={isAdmin} selected={selected.has(s.id)} {...handlers(s)} />
                ))}
              </div>
            ) : (
              <div className="card ag-tablecard">
                <div className="table-wrap">
                  <table className="table ag-table">
                    <thead>
                      <tr>
                        <th className="w-check">
                          {isAdmin && (
                            <input
                              type="checkbox"
                              className="checkbox"
                              checked={allVisibleSelected}
                              onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                              aria-label="Select all"
                            />
                          )}
                        </th>
                        <th>Sub-account</th>
                        <th>WhatsApp</th>
                        <th>Numbers</th>
                        <th>Plan</th>
                        <th style={{ textAlign: 'right' }}>Msgs · 24h</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((s) => (
                        <Row key={s.id} s={s} isAdmin={isAdmin} selected={selected.has(s.id)} {...handlers(s)} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {selected.size > 0 && (
        <div className="bulkbar">
          <b>{plural(selected.size, 'sub-account')} selected</b>
          <Button size="sm" variant="secondary" icon="check" onClick={() => bulk(true)}>
            Enable WhatsApp
          </Button>
          <Button size="sm" variant="secondary" icon="lock" onClick={() => bulk(false)}>
            Disable
          </Button>
          <button className="icon-btn" style={{ color: '#fff' }} onClick={() => setSelected(new Set())} aria-label="Clear selection">
            <Icon name="x" size={16} />
          </button>
        </div>
      )}

      {open && (
        <SubAccountDrawer
          s={open}
          isAdmin={isAdmin}
          onClose={() => setOpenId(null)}
          onChanged={() => load()}
          onToggle={(v) => setAccess(open, v)}
        />
      )}
      {linkFor && (
        <ConnectNumberModal
          locationId={linkFor.id}
          locationName={linkFor.name}
          onClose={() => {
            setLinkFor(null);
            load();
          }}
          onLinked={() => load()}
        />
      )}
    </div>
  );
}

/* ── Shared bits ─────────────────────────────────────────────── */

const AVATAR_TONES = [
  ['#e3f4ea', '#cfead9', '#0f6b35'],
  ['#e8effd', '#d5e2fb', '#2350c2'],
  ['#fdf1e2', '#f8e2c3', '#9a5508'],
  ['#f1ebfd', '#e2d6fa', '#6239b5'],
  ['#fde9ef', '#f9d3df', '#ad2f56'],
  ['#e1f4f4', '#c8eaea', '#0b6b6b'],
  ['#f0f1e2', '#e2e5c6', '#56601a'],
  ['#fcede5', '#f7d9c8', '#a8461c'],
];

function toneFor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

/** Logo, or initials on a soft colour that is stable per name. */
function AgAvatar({ name, src, size = 40 }) {
  const [bg, bg2, fg] = toneFor(name);
  return (
    <span
      className="ag-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36), color: fg, background: src ? '#fff' : `linear-gradient(140deg, ${bg}, ${bg2})` }}
    >
      {src ? <img src={src} alt="" /> : initials(String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' '))}
    </span>
  );
}

const ArrowIn = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 7 7 17M16 17H7V8" />
  </svg>
);
const ArrowOut = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

function ViewToggle({ value, onChange }) {
  const opts = [
    {
      v: 'cards',
      label: 'Cards',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
        </svg>
      ),
    },
    {
      v: 'list',
      label: 'List',
      icon: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M9 6h11M9 12h11M9 18h11" />
          <circle cx="4.5" cy="6" r="0.6" fill="currentColor" />
          <circle cx="4.5" cy="12" r="0.6" fill="currentColor" />
          <circle cx="4.5" cy="18" r="0.6" fill="currentColor" />
        </svg>
      ),
    },
  ];
  return (
    <div className="ag-view" role="radiogroup" aria-label="Layout">
      {opts.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)} title={`${o.label} view`}>
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function AgEmpty({ icon, title, children, action }) {
  return (
    <div className="ag-empty">
      <div className="ag-empty-art" aria-hidden="true">
        <span className="ag-empty-tile back" />
        <span className="ag-empty-tile mid" />
        <span className="ag-empty-tile front">
          <Icon name={icon} size={22} />
        </span>
      </div>
      <h4>{title}</h4>
      {children && <p>{children}</p>}
      {action && <div className="ag-empty-action">{action}</div>}
    </div>
  );
}

function accessMenu(s, isAdmin, { onOpen, onLink, onToggle }) {
  return [
    { label: 'Manage', icon: 'settings', onClick: onOpen },
    isAdmin && s.allowed && { label: 'Link a number', icon: 'qr', onClick: onLink },
    isAdmin && '-',
    isAdmin && (s.allowed ? { label: 'Disable WhatsApp', icon: 'lock', danger: true, onClick: () => onToggle(false) } : { label: 'Enable WhatsApp', icon: 'check', onClick: () => onToggle(true) }),
  ];
}

/* ── Card view ───────────────────────────────────────────────── */

const SHOWN_NUMBERS = 3;

function SubCard({ s, isAdmin, selected, onSelect, onOpen, onToggle, onLink, onDecline }) {
  const sub = subscriptionLabel(s.subscription);
  const shown = s.numbers.slice(0, SHOWN_NUMBERS);
  const more = s.numbers.length - shown.length;
  const msgs = s.messages24h;
  const stop = (e) => e.stopPropagation();
  const cls = ['ag-card', !s.allowed && !s.request ? 'is-off' : '', selected ? 'is-selected' : '', s.request ? 'has-request' : '', s.attention > 0 ? 'has-attn' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <article className={cls} onClick={onOpen}>
      {s.request && (
        <div className="ag-req" onClick={stop}>
          <div className="ag-req-top">
            <span className="ag-req-ic">
              <Icon name="users" size={13} />
            </span>
            <span className="ag-req-who">
              <b>{s.request.requestedBy?.name || 'A user'}</b> asked for WhatsApp
            </span>
            {s.request.requestedAt && <span className="ag-req-when">{timeAgo(s.request.requestedAt)}</span>}
          </div>
          {s.request.message && <p className="ag-req-msg">“{s.request.message}”</p>}
          {isAdmin && (
            <div className="ag-req-actions">
              <Button size="sm" variant="primary" icon="check" onClick={() => onToggle(true)}>
                Approve
              </Button>
              <Button size="sm" variant="ghost" onClick={onDecline}>
                Decline
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="ag-card-body">
        <div className="ag-card-head">
          <div className="ag-avatar-slot">
            <AgAvatar name={s.name} src={s.logoUrl} />
            {isAdmin && (
              <button
                type="button"
                role="checkbox"
                aria-checked={selected}
                aria-label={`Select ${s.name}`}
                className="ag-check"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect();
                }}
              >
                <Icon name="check" size={13} stroke={3} />
              </button>
            )}
          </div>
          <div className="ag-card-id">
            <button type="button" className="ag-card-name" onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }} title={s.name}>
              {s.name}
            </button>
            <div className="ag-card-sub" title={[s.city, s.email].filter(Boolean).join(' · ')}>
              {s.city || s.email || s.id}
            </div>
          </div>
          {s.attention > 0 && (
            <span className="ag-attn" title={`${plural(s.attention, 'number')} logged out or dropped`}>
              <span className="ag-attn-dot" />
              Needs attention
            </span>
          )}
        </div>

        {!s.request && (
          <div className={`ag-access ${s.allowed ? 'on' : ''}`} onClick={stop}>
            <div className="ag-access-text">
              <span className="ag-access-t">{s.allowed ? 'WhatsApp on' : 'WhatsApp off'}</span>
              <span className="ag-access-d">{s.override === null ? 'Following agency default' : s.allowed ? 'Enabled by you' : 'Turned off by you'}</span>
            </div>
            <Toggle on={s.allowed} onChange={onToggle} disabled={!isAdmin} label={`WhatsApp for ${s.name}`} />
          </div>
        )}

        <div className="ag-nums">
          <div className="ag-nums-head">
            <span>Numbers</span>
            {s.numbers.length > 0 && (
              <span className="ag-nums-count">
                {s.connected}/{s.numbers.length} connected
              </span>
            )}
          </div>
          {s.numbers.length === 0 ? (
            <div className="ag-nums-empty">
              <span className="ag-nums-empty-ic">
                <Icon name="phone" size={14} />
              </span>
              <span className="grow">{s.allowed ? 'No numbers linked' : 'Turn WhatsApp on to link a number'}</span>
              {s.allowed && isAdmin && (
                <Button
                  size="sm"
                  icon="plus"
                  onClick={(e) => {
                    e.stopPropagation();
                    onLink();
                  }}
                >
                  Link number
                </Button>
              )}
            </div>
          ) : (
            <ul className="ag-num-list">
              {shown.map((n) => {
                const m = statusMeta(n.status, n.pausedReason);
                return (
                  <li key={n.id} className={`ag-num ${m.tone}`} title={m.label}>
                    <span className={`ag-num-dot ${m.tone}`} />
                    <span className="ag-num-phone tnum">{n.phoneNumber ? formatPhone(n.phoneNumber) : 'Linking…'}</span>
                    <span className="ag-num-label">{n.label || n.waName}</span>
                    {n.isDefault && <span className="ag-num-default">Default</span>}
                    {m.tone !== 'ok' && <span className={`ag-num-status ${m.tone}`}>{m.label}</span>}
                  </li>
                );
              })}
              {more > 0 && (
                <li className="ag-num-more">
                  <button type="button" onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}>
                    +{plural(more, 'more number')}
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="ag-meta">
          <Pill tone={sub.tone}>{sub.label}</Pill>
          <span className="ag-io" title="Messages in the last 24 hours">
            <span className="in">
              <ArrowIn />
              {msgs.inbound.toLocaleString()}
            </span>
            <span className="out">
              <ArrowOut />
              {msgs.outbound.toLocaleString()}
            </span>
            <span className="ag-io-l">24h</span>
          </span>
        </div>
      </div>

      <footer className="ag-card-foot" onClick={stop}>
        {s.allowed && isAdmin && s.numbers.length > 0 ? (
          <Button size="sm" icon="qr" onClick={onLink}>
            Link number
          </Button>
        ) : (
          <span />
        )}
        <div className="ag-card-foot-r">
          <Button size="sm" variant="ghost" icon="settings" onClick={onOpen}>
            Manage
          </Button>
          <Menu items={accessMenu(s, isAdmin, { onOpen, onLink, onToggle })} />
        </div>
      </footer>
    </article>
  );
}

/* ── List view ───────────────────────────────────────────────── */

function Row({ s, isAdmin, selected, onSelect, onOpen, onToggle, onLink, onDecline }) {
  const sub = subscriptionLabel(s.subscription);
  const shown = s.numbers.slice(0, 2);
  const total = s.messages24h.inbound + s.messages24h.outbound;
  return (
    <tr className={`${selected ? 'selected' : ''} ${!s.allowed && !s.request ? 'is-off' : ''}`} onClick={onOpen} style={{ cursor: 'pointer' }}>
      <td className="w-check" onClick={(e) => e.stopPropagation()}>
        {isAdmin && <input type="checkbox" className="checkbox" checked={selected} onChange={onSelect} aria-label={`Select ${s.name}`} />}
      </td>
      <td>
        <div className="ag-row-name">
          <AgAvatar name={s.name} src={s.logoUrl} size={34} />
          <div style={{ minWidth: 0 }}>
            <div className="n">
              {s.name}
              {s.attention > 0 && <span className="ag-attn-dot" title="Needs attention" />}
            </div>
            <div className="s">{s.city || s.email || s.id}</div>
          </div>
        </div>
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        {s.request ? (
          <div className="row" style={{ gap: 6 }}>
            <Pill tone="warn" dot>
              Requested
            </Pill>
            {isAdmin && (
              <>
                <Button size="sm" variant="primary" onClick={() => onToggle(true)}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost" onClick={onDecline}>
                  Decline
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            <Toggle on={s.allowed} onChange={onToggle} disabled={!isAdmin} label={`WhatsApp for ${s.name}`} />
            <span className="ag-row-access">
              {s.allowed ? 'On' : 'Off'}
              {s.override === null && <span title="Follows your agency default"> · default</span>}
            </span>
          </div>
        )}
      </td>
      <td>
        {s.numbers.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <div className="row wrap" style={{ gap: 6 }}>
            {shown.map((n) => {
              const m = statusMeta(n.status, n.pausedReason);
              return (
                <span key={n.id} className="num-chip ag-chip" title={`${m.label}${n.label ? ` · ${n.label}` : ''}`}>
                  <span className={`dot ${m.tone}`} />
                  {n.phoneNumber ? formatPhone(n.phoneNumber) : n.label || 'Linking…'}
                </span>
              );
            })}
            {s.numbers.length > shown.length && <span className="muted">+{s.numbers.length - shown.length}</span>}
          </div>
        )}
      </td>
      <td>
        <Pill tone={sub.tone}>{sub.label}</Pill>
      </td>
      <td style={{ textAlign: 'right' }} className="tnum">
        {total ? (
          <span className="ag-io ag-io-row">
            <span className="in">
              <ArrowIn />
              {s.messages24h.inbound}
            </span>
            <span className="out">
              <ArrowOut />
              {s.messages24h.outbound}
            </span>
          </span>
        ) : (
          <span className="muted">0</span>
        )}
      </td>
      <td onClick={(e) => e.stopPropagation()} style={{ width: 150 }}>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
          {s.allowed && isAdmin && (
            <Button size="sm" icon="qr" onClick={onLink}>
              Link
            </Button>
          )}
          <Menu items={accessMenu(s, isAdmin, { onOpen, onLink, onToggle })} />
        </div>
      </td>
    </tr>
  );
}

/* ── KPI tile ────────────────────────────────────────────────── */

function Kpi({ k, v, sub, icon, h, tone = 'brand', meter, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`ag-kpi ${tone} ${onClick ? 'clickable' : ''}`} onClick={onClick || undefined}>
      <div className="ag-kpi-top">
        <span className="ag-kpi-ic">
          <Icon name={icon} size={15} />
        </span>
        <span className="ag-kpi-k">{k}</span>
        {onClick && <Icon name="chevron" size={14} className="ag-kpi-go" />}
      </div>
      <div className="ag-kpi-v tnum">
        {v}
        {sub && <small>{sub}</small>}
      </div>
      {meter != null && (
        <div className="ag-kpi-meter" aria-hidden="true">
          <span style={{ width: `${Math.round(Math.min(1, Math.max(0, meter)) * 100)}%` }} />
        </div>
      )}
      {h && <div className="ag-kpi-h">{h}</div>}
    </Tag>
  );
}

/* ── Loading skeleton (mirrors the real layout) ──────────────── */

function AgencySkeleton() {
  return (
    <div className="ag-page" aria-busy="true" aria-label="Loading sub-accounts">
      <div className="ag-head">
        <div className="ag-head-text" style={{ width: '100%', maxWidth: 520 }}>
          <span className="boot-sk" style={{ width: 96, height: 11 }} />
          <span className="boot-sk" style={{ width: '70%', height: 26, marginTop: 10 }} />
          <span className="boot-sk" style={{ width: '92%', height: 13, marginTop: 10 }} />
        </div>
        <div className="ag-head-actions">
          <span className="boot-sk" style={{ width: 92, height: 12 }} />
          <span className="boot-sk" style={{ width: 96, height: 36, borderRadius: 10 }} />
          <span className="boot-sk" style={{ width: 150, height: 36, borderRadius: 10 }} />
        </div>
      </div>
      <div className="ag-kpis">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="ag-kpi sk">
            <div className="ag-kpi-top">
              <span className="boot-sk" style={{ width: 30, height: 30, borderRadius: 9 }} />
              <span className="boot-sk" style={{ width: '50%', height: 12 }} />
            </div>
            <span className="boot-sk" style={{ width: 64, height: 28, marginTop: 14 }} />
            <span className="boot-sk" style={{ width: '70%', height: 11, marginTop: 12 }} />
          </div>
        ))}
      </div>
      <div className="ag-toolbar">
        <span className="boot-sk" style={{ width: 280, maxWidth: '100%', height: 38, borderRadius: 10 }} />
        <span className="boot-sk" style={{ width: 420, maxWidth: '100%', height: 34, borderRadius: 10 }} />
      </div>
      <div className="ag-grid">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="ag-card sk">
            <div className="ag-card-body">
              <div className="ag-card-head">
                <span className="boot-sk" style={{ width: 40, height: 40, borderRadius: 12 }} />
                <div className="ag-card-id">
                  <span className="boot-sk" style={{ width: '62%', height: 14 }} />
                  <span className="boot-sk" style={{ width: '40%', height: 11, marginTop: 7 }} />
                </div>
              </div>
              <span className="boot-sk" style={{ height: 52, borderRadius: 12 }} />
              <span className="boot-sk" style={{ width: '35%', height: 10 }} />
              <span className="boot-sk" style={{ height: 34, borderRadius: 10, marginTop: -4 }} />
              <div className="ag-meta">
                <span className="boot-sk" style={{ width: 92, height: 22, borderRadius: 99 }} />
                <span className="boot-sk" style={{ width: 70, height: 12 }} />
              </div>
            </div>
            <div className="ag-card-foot">
              <span className="boot-sk" style={{ width: 110, height: 30, borderRadius: 8 }} />
              <span className="boot-sk" style={{ width: 90, height: 30, borderRadius: 8 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
