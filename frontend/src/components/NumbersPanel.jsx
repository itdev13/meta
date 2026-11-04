import { useCallback, useEffect, useMemo, useState } from 'react';
import { loc } from '../lib/api';
import { groupsApi } from '../lib/api-groups';
import { formatPhone, statusMeta, timeAgo, plural } from '../lib/format';
import { Banner, Button, Confirm, Empty, Field, Menu, Modal, Pill, Skeleton, Toggle, useAction } from './ui';
import { Icon, WaGlyph } from './icons';
import ConnectNumberModal from './ConnectNumberModal';

const LIVE = new Set(['qr', 'pairing', 'connecting', 'disconnected', 'pending']);
const NEEDS_RELINK = new Set(['logged_out', 'banned', 'replaced', 'qr_expired']);

/**
 * The linked-number manager, shared by the sub-account page and the agency drawer.
 *   numbers   — list from the API (kept fresh by the parent via live events)
 *   limit     — effective number limit; null hides the counter
 *   canManage — false → read-only (agency manages numbers for this sub-account)
 *   isAgency  — agency session: can edit sending limits
 */
export default function NumbersPanel({ locationId, locationName, numbers, limit, canManage, isAgency, onChanged, lockedReason, compact }) {
  const api = loc(locationId);
  const act = useAction();
  const [connect, setConnect] = useState(null); // {} for new, number for relink
  const [settingsFor, setSettingsFor] = useState(null);
  const [groupsFor, setGroupsFor] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const occupying = numbers.filter((n) => n.isActive && !NEEDS_RELINK.has(n.status) && n.status !== 'paused').length;
  const atLimit = limit != null && occupying >= limit;
  const linkable = canManage && !atLimit;

  const run = async (fn, msg) => {
    const r = await act(fn, msg);
    onChanged?.();
    return r;
  };

  return (
    <>
      {limit != null && !compact && (
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="muted">
            <b style={{ color: 'var(--ink)' }}>{occupying}</b> of {plural(limit, 'number')} in use
          </div>
          {lockedReason && <div className="muted" style={{ fontSize: 12.5 }}>{lockedReason}</div>}
        </div>
      )}

      <div className="numbers-grid" style={compact ? { gridTemplateColumns: '1fr' } : undefined}>
        {numbers.map((n) => (
          <NumberCard
            key={n.id}
            n={n}
            canManage={canManage}
            onRelink={() => setConnect(n)}
            onResume={() => run(() => api.resume(n.id), 'Reconnecting…')}
            onPause={() => run(() => api.pause(n.id), 'Number paused')}
            onDefault={() => run(() => api.update(n.id, { isDefault: true }), 'Default number updated')}
            onSettings={() => setSettingsFor(n)}
            onGroups={() => setGroupsFor(n)}
            onUnlink={() =>
              setConfirm({
                title: 'Unlink this number?',
                body: (
                  <>
                    <b>{formatPhone(n.phoneNumber) || n.label || 'This number'}</b> will be logged out from WhatsApp Web and removed. Past
                    messages stay in Conversations. You can link it again anytime.
                  </>
                ),
                label: 'Unlink number',
                fn: () => run(() => api.unlink(n.id), 'Number unlinked'),
              })
            }
          />
        ))}

        <button className="add-tile" disabled={!linkable} onClick={() => setConnect({})}>
          <span className="plus">
            <Icon name={canManage ? 'plus' : 'lock'} size={20} />
          </span>
          <b>{numbers.length ? 'Link another number' : 'Link a WhatsApp number'}</b>
          <span className="muted" style={{ fontSize: 12.5, maxWidth: 240 }}>
            {!canManage
              ? lockedReason || 'Numbers are managed by your agency.'
              : atLimit
                ? `You’re using all ${plural(limit, 'number')} on this plan.`
                : 'Scan a QR code or use a pairing code — takes under a minute.'}
          </span>
        </button>
      </div>

      {connect && (
        <ConnectNumberModal
          locationId={locationId}
          locationName={locationName}
          relink={connect.id ? connect : null}
          onClose={() => {
            setConnect(null);
            onChanged?.();
          }}
          onLinked={onChanged}
        />
      )}
      {settingsFor && (
        <NumberSettings
          n={settingsFor}
          isAgency={isAgency}
          onClose={() => setSettingsFor(null)}
          onSave={async (patch) => {
            const r = await run(() => api.update(settingsFor.id, patch), 'Settings saved');
            if (r) setSettingsFor(null);
          }}
        />
      )}
      {groupsFor && (
        <GroupsModal
          n={numbers.find((x) => x.id === groupsFor.id) || groupsFor}
          locationId={locationId}
          onClose={() => setGroupsFor(null)}
          onEnableSync={() => run(() => api.update(groupsFor.id, { settings: { syncGroups: true } }), 'Group sync turned on')}
        />
      )}
      {confirm && (
        <Confirm title={confirm.title} danger confirmLabel={confirm.label} onConfirm={confirm.fn} onClose={() => setConfirm(null)}>
          {confirm.body}
        </Confirm>
      )}
    </>
  );
}

function NumberCard({ n, canManage, onRelink, onResume, onPause, onDefault, onSettings, onGroups, onUnlink }) {
  const meta = statusMeta(n.status, n.pausedReason);
  const dim = n.status !== 'connected';
  const relink = NEEDS_RELINK.has(n.status);
  return (
    <div className={`card ncard ${dim ? 'dim' : ''}`}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="wa">
          <WaGlyph size={24} />
        </div>
        <div className="grow">
          <div className="row" style={{ gap: 8 }}>
            <span className="phone">{n.phoneNumber ? formatPhone(n.phoneNumber) : n.label || 'New number'}</span>
            {n.isDefault && <span className="default-tag">Default</span>}
            {n.settings?.syncGroups && (
              <span className="grp-tag" title="WhatsApp groups sync to the CRM">
                <Icon name="users" size={11} />
                Groups
              </span>
            )}
          </div>
          <div className="sub">
            {[n.label && n.phoneNumber ? n.label : null, n.waName].filter(Boolean).join(' · ') || 'WhatsApp'}
          </div>
        </div>
        {canManage && (
          <Menu
            items={[
              { label: 'Settings', icon: 'sliders', onClick: onSettings },
              n.status === 'connected' && { label: 'WhatsApp groups', icon: 'users', onClick: onGroups },
              !n.isDefault && n.status === 'connected' && { label: 'Make default', icon: 'star', onClick: onDefault },
              n.status === 'connected' && { label: 'Pause', icon: 'pause', onClick: onPause },
              (n.status === 'paused' || n.status === 'disconnected') && { label: 'Reconnect', icon: 'play', onClick: onResume },
              '-',
              { label: 'Unlink number', icon: 'unlink', danger: true, onClick: onUnlink },
            ]}
          />
        )}
      </div>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Pill tone={meta.tone} dot live={LIVE.has(n.status)}>
          {meta.label}
        </Pill>
        <span className="muted" style={{ fontSize: 12 }}>
          {n.status === 'connected' ? `Active ${timeAgo(n.lastMessageAt || n.connectedAt)}` : n.lastDisconnectAt ? `Since ${timeAgo(n.lastDisconnectAt)}` : ''}
        </span>
      </div>

      <div className="meta">
        <div>
          <div className="k">Sent today</div>
          <div className="v">{n.sentToday}</div>
        </div>
        <div>
          <div className="k">Received</div>
          <div className="v">{n.totals.inbound}</div>
        </div>
        <div>
          <div className="k">Sent total</div>
          <div className="v">{n.totals.outbound}</div>
        </div>
      </div>

      {n.lastError && n.status !== 'connected' && <div className="err-note">{n.lastError}</div>}

      {canManage && relink && (
        <Button variant="primary" icon="qr" onClick={onRelink}>
          Link again
        </Button>
      )}
      {canManage && (n.status === 'paused' || n.status === 'disconnected') && n.pausedReason !== 'agency_disabled' && n.pausedReason !== 'plan_limit' && (
        <Button icon="play" onClick={onResume}>
          Reconnect
        </Button>
      )}
    </div>
  );
}

function NumberSettings({ n, isAgency, onClose, onSave }) {
  const [label, setLabel] = useState(n.label || '');
  const [s, setS] = useState(n.settings);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    const settings = { markRead: s.markRead, typingSimulation: s.typingSimulation, syncPhoneReplies: s.syncPhoneReplies, syncGroups: !!s.syncGroups };
    if (isAgency) {
      settings.minDelayMs = s.minDelayMs === '' ? null : s.minDelayMs;
      settings.dailyLimit = s.dailyLimit === '' ? null : s.dailyLimit;
    }
    await onSave({ label, settings });
    setBusy(false);
  };
  const rows = [
    ['syncPhoneReplies', 'Sync replies sent from the phone', 'Messages you type in the WhatsApp app also appear in Conversations.'],
    ['typingSimulation', 'Show “typing…” before sending', 'Makes automated replies look natural and lowers the risk of restrictions.'],
    ['markRead', 'Mark messages as read', 'Customers see blue ticks as soon as a message syncs to the CRM.'],
    [
      'syncGroups',
      'Sync WhatsApp groups',
      'Each group this number is in becomes one CRM contact (“👥 Group name”). Messages show who wrote them, and replies from Conversations go to the whole group. Off: group chats are ignored.',
    ],
  ];
  return (
    <Modal
      title="Number settings"
      subtitle={formatPhone(n.phoneNumber) || n.label}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        <Field label="Label">
          <input className="input" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Sales line" />
        </Field>
        <div>
          {rows.map(([k, t, d]) => (
            <div className="setting-row" key={k}>
              <div>
                <div className="t">{t}</div>
                <div className="d">{d}</div>
              </div>
              <Toggle on={!!s[k]} onChange={(v) => set(k, v)} label={t} />
            </div>
          ))}
        </div>
        {isAgency && (
          <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
            <div className="section-title">Sending pace · agency only</div>
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <Field label="Min. delay between sends (ms)" hint="Blank = agency default">
                <input className="input tnum" type="number" min={300} value={s.minDelayMs ?? ''} onChange={(e) => set('minDelayMs', e.target.value === '' ? '' : Number(e.target.value))} />
              </Field>
              <Field label="Daily send limit" hint="Blank = agency default">
                <input className="input tnum" type="number" min={1} value={s.dailyLimit ?? ''} onChange={(e) => set('dailyLimit', e.target.value === '' ? '' : Number(e.target.value))} />
              </Field>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── WhatsApp groups (feature: groups) ───────────────────────────────

function GroupsModal({ n, locationId, onClose, onEnableSync }) {
  const gapi = useMemo(() => groupsApi(locationId), [locationId]);
  const act = useAction();
  const [state, setState] = useState({ loading: true, error: '', groups: [], syncGroups: !!n.settings?.syncGroups });
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null); // jid being linked
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (refresh) => {
      if (refresh) setRefreshing(true);
      try {
        const data = await gapi.list({ numberId: n.id, refresh });
        const row = data?.numbers?.[0];
        setState({ loading: false, error: row?.error || '', groups: row?.groups || [], syncGroups: !!row?.syncGroups });
      } catch (err) {
        setState((x) => ({ ...x, loading: false, error: err.message || 'Could not load groups.' }));
      } finally {
        setRefreshing(false);
      }
    },
    [gapi, n.id],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const syncOn = state.syncGroups || !!n.settings?.syncGroups;
  const term = q.trim().toLowerCase();
  const shown = term ? state.groups.filter((g) => (g.subject || '').toLowerCase().includes(term)) : state.groups;
  const linkedCount = state.groups.filter((g) => g.mapped).length;

  const link = async (g) => {
    setBusy(g.jid);
    const r = await act(() => gapi.link(g.jid, n.id), `“${g.subject || 'Group'}” linked to the CRM`);
    if (r) setState((x) => ({ ...x, groups: x.groups.map((y) => (y.jid === g.jid ? { ...y, mapped: true, contactId: r.contactId } : y)) }));
    setBusy(null);
  };

  return (
    <Modal
      wide
      title="WhatsApp groups"
      subtitle={`${formatPhone(n.phoneNumber) || n.label || 'This number'}${state.loading ? '' : ` · ${plural(state.groups.length, 'group')} · ${linkedCount} in CRM`}`}
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="stack grp-wrap" style={{ gap: 14 }}>
        {!syncOn && (
          <Banner
            tone="warn"
            icon="info"
            title="Group sync is off for this number"
            action={
              onEnableSync && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={async () => {
                    await onEnableSync();
                    setState((x) => ({ ...x, syncGroups: true }));
                  }}
                >
                  Turn on
                </Button>
              )
            }
          >
            Linked groups can still receive replies from Conversations, but new group messages won’t sync to the CRM until you turn it on.
          </Banner>
        )}

        <div className="grp-toolbar">
          <div className="input-icon grow">
            <Icon name="search" size={15} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups" aria-label="Search groups" />
          </div>
          <Button icon="refresh" loading={refreshing} onClick={() => load(true)} disabled={state.loading}>
            Refresh
          </Button>
        </div>

        {state.loading ? (
          <div className="grp-list">
            {[0, 1, 2, 3].map((i) => (
              <div className="grp-row" key={i}>
                <Skeleton h={38} w={38} r={11} />
                <div className="grow stack" style={{ gap: 6 }}>
                  <Skeleton h={13} w="45%" />
                  <Skeleton h={11} w="25%" />
                </div>
              </div>
            ))}
          </div>
        ) : state.error ? (
          <Empty icon="alert" title="Couldn’t load groups" action={<Button icon="refresh" onClick={() => load(true)}>Try again</Button>}>
            {state.error}
          </Empty>
        ) : !state.groups.length ? (
          <Empty icon="users" title="No groups yet">
            This number isn’t in any WhatsApp groups. Groups it joins will show up here.
          </Empty>
        ) : !shown.length ? (
          <Empty icon="search" title="No matching groups">
            Nothing matches “{q}”.
          </Empty>
        ) : (
          <div className="grp-list">
            {shown.map((g) => (
              <div className={`grp-row ${g.mapped ? 'linked' : ''}`} key={g.jid}>
                <div className="grp-av">
                  <Icon name="users" size={18} />
                </div>
                <div className="grow">
                  <div className="grp-name" title={g.subject}>
                    {g.subject || 'Untitled group'}
                  </div>
                  <div className="grp-meta">
                    <span>{plural(g.size || 0, 'member')}</span>
                    {g.isAdmin && <span className="grp-chip">Admin</span>}
                    {g.announce && <span className="grp-chip muted-chip" title="Only admins can send messages">Admins only</span>}
                    {g.lastActivityAt && <span>Active {timeAgo(g.lastActivityAt)}</span>}
                  </div>
                </div>
                {g.mapped ? (
                  <Pill tone={syncOn ? 'ok' : 'neutral'} dot>
                    {syncOn ? 'Syncing' : 'In CRM'}
                  </Pill>
                ) : (
                  <Button size="sm" icon="plus" loading={busy === g.jid} disabled={!!busy && busy !== g.jid} onClick={() => link(g)}>
                    Link to CRM
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="muted grp-foot">
          Each linked group is one CRM contact tagged <b>whatsapp-group</b>. Group sends count toward this number’s daily limit.
        </div>
      </div>
    </Modal>
  );
}
