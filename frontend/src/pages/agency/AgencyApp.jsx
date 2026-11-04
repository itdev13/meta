import { useCallback, useEffect, useMemo, useState } from 'react';
import { agency } from '../../lib/api';
import { useLiveStatus } from '../../lib/live';
import { formatPhone, plural, statusMeta, subscriptionLabel, timeAgo } from '../../lib/format';
import { Avatar, Banner, Button, Empty, Menu, Pill, Segmented, Skeleton, Toggle, useAction } from '../../components/ui';
import { Icon } from '../../components/icons';
import Topbar from '../../components/Topbar';
import ConnectNumberModal from '../../components/ConnectNumberModal';
import SubAccountDrawer from './SubAccountDrawer';
import PolicyPanel from './PolicyPanel';
import AgencyAnalytics from './AgencyAnalytics';

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
  const isAdmin = context.isAdmin;

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
          <>
            <div className="page-head">
              <div>
                <h1>WhatsApp across your agency</h1>
                <p>Decide which sub-accounts can use WhatsApp, link numbers for clients, and keep an eye on every connection from one place.</p>
              </div>
              <div className="row">
                <span className="muted" style={{ fontSize: 12 }}>
                  {data.syncedAt ? `Synced ${timeAgo(data.syncedAt)}` : ''}
                </span>
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
              </div>
            </div>

            {!data.agencyInstalled && (
              <Banner tone="info" icon="info" title="Install at the agency level to see every sub-account">
                Only sub-accounts that installed the app on their own are listed. Install from the marketplace as an agency to manage all of them
                from here.
              </Banner>
            )}

            {data.notInstalled > 0 && (
              <div className="muted" style={{ fontSize: 13, margin: '-8px 0 14px' }}>
                Showing the {plural(data.summary.subAccounts, 'sub-account')} with the app installed. {plural(data.notInstalled, 'other sub-account')} in
                your agency {data.notInstalled === 1 ? 'hasn’t' : 'haven’t'} installed it yet. Install it on them from the marketplace to manage them here.
              </div>
            )}

            <div className="stats">
              <Kpi k="WhatsApp enabled" v={summary.allowed} sub={`/ ${summary.subAccounts}`} icon="building" h={data.settings.accessMode === 'all' ? 'All sub-accounts by default' : 'Only ones you choose'} />
              <Kpi k="Connected numbers" v={summary.connectedNumbers} icon="phone" />
              <Kpi k="Need attention" v={summary.attention} icon="alert" tone={summary.attention ? 'attention' : ''} h={summary.attention ? 'Logged out or dropped' : 'All healthy'} />
              <Kpi k="Messages · 24h" v={summary.messages24h.toLocaleString()} icon="message" />
            </div>

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

            <div className="card">
              <div className="toolbar">
                <div className="input-icon" style={{ width: 280 }}>
                  <Icon name="search" size={15} />
                  <input className="input" placeholder="Search name, email, number…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
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
              {rows.length === 0 ? (
                <Empty icon="search" title={data.subAccounts.length ? 'No sub-accounts match' : 'No sub-accounts yet'}>
                  {data.subAccounts.length ? 'Try a different search or filter.' : 'Install the app on a sub-account from the marketplace, then switch WhatsApp on for it here.'}
                </Empty>
              ) : (
                <div className="table-wrap">
                  <table className="table">
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
                        <Row
                          key={s.id}
                          s={s}
                          isAdmin={isAdmin}
                          selected={selected.has(s.id)}
                          onSelect={() =>
                            setSelected((prev) => {
                              const n = new Set(prev);
                              if (n.has(s.id)) n.delete(s.id);
                              else n.add(s.id);
                              return n;
                            })
                          }
                          onOpen={() => setOpenId(s.id)}
                          onToggle={(v) => setAccess(s, v)}
                          onLink={() => setLinkFor(s)}
                          onDecline={async () => {
                            await act(() => agency.decline(s.id), 'Request declined');
                            load();
                          }}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
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

function Row({ s, isAdmin, selected, onSelect, onOpen, onToggle, onLink, onDecline }) {
  const sub = subscriptionLabel(s.subscription);
  const shown = s.numbers.slice(0, 2);
  return (
    <tr className={selected ? 'selected' : ''} onClick={onOpen} style={{ cursor: 'pointer' }}>
      <td className="w-check" onClick={(e) => e.stopPropagation()}>
        {isAdmin && <input type="checkbox" className="checkbox" checked={selected} onChange={onSelect} aria-label={`Select ${s.name}`} />}
      </td>
      <td>
        <div className="row name-cell">
          <Avatar name={s.name} src={s.logoUrl} />
          <div style={{ minWidth: 0 }}>
            <div className="n">{s.name}</div>
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
            <span className="muted" style={{ fontSize: 12.5 }}>
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
                <span key={n.id} className="num-chip" title={`${m.label}${n.label ? ` · ${n.label}` : ''}`}>
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
        {s.messages24h.inbound + s.messages24h.outbound || <span className="muted">0</span>}
      </td>
      <td onClick={(e) => e.stopPropagation()} style={{ width: 150 }}>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
          {s.allowed && isAdmin && (
            <Button size="sm" icon="qr" onClick={onLink}>
              Link
            </Button>
          )}
          <Menu
            items={[
              { label: 'Manage', icon: 'settings', onClick: onOpen },
              isAdmin && s.allowed && { label: 'Link a number', icon: 'qr', onClick: onLink },
              isAdmin && '-',
              isAdmin && (s.allowed ? { label: 'Disable WhatsApp', icon: 'lock', danger: true, onClick: () => onToggle(false) } : { label: 'Enable WhatsApp', icon: 'check', onClick: () => onToggle(true) }),
            ]}
          />
        </div>
      </td>
    </tr>
  );
}

function Kpi({ k, v, sub, icon, h, tone = '' }) {
  return (
    <div className={`card stat ${tone}`}>
      <div className="k">
        <Icon name={icon} size={14} />
        {k}
      </div>
      <div className="v">
        {v}
        {sub && <small>{sub}</small>}
      </div>
      {h && <div className="h">{h}</div>}
    </div>
  );
}

function AgencySkeleton() {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Skeleton h={30} w={320} />
      <div className="stats">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} h={104} r={16} />
        ))}
      </div>
      <div className="card" style={{ padding: 16 }}>
        <div className="stack">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} h={40} />
          ))}
        </div>
      </div>
    </div>
  );
}
