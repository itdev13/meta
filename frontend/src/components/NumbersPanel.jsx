import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loc } from '../lib/api';
import { groupsApi } from '../lib/api-groups';
import { routingApi } from '../lib/api-routing';
import { shareApi, shareUrl } from '../lib/api-share';
import { proxyApi } from '../lib/api-proxy';
import { formatPhone, initials, statusMeta, timeAgo, plural } from '../lib/format';
import { Banner, Button, Confirm, Empty, Field, Menu, Modal, Pill, Segmented, Skeleton, Toggle, useAction, useToast } from './ui';
import { Icon, WaGlyph } from './icons';
import ConnectNumberModal from './ConnectNumberModal';

const LIVE = new Set(['qr', 'pairing', 'connecting', 'disconnected', 'pending']);
const NEEDS_RELINK = new Set(['logged_out', 'banned', 'replaced', 'qr_expired']);
/** Statuses where a socket exists (or is retrying), so a proxy change can be applied right away. */
const APPLIABLE = new Set(['connected', 'connecting', 'disconnected']);

// ── Small helpers ───────────────────────────────────────────────────

/** "GB" → 🇬🇧 (regional indicator symbols). */
export function flagEmoji(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

let regionNames = null;
function countryName(code) {
  if (!code) return '';
  try {
    regionNames = regionNames || new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}

/** Display name for a number: "WhatsApp #2". */
const numberName = (n) => n?.name || (n?.index ? `WhatsApp #${n.index}` : 'WhatsApp');

/** Normalise user input to E.164-ish "+digits"; null when it can't be a phone number. */
function toE164(raw) {
  const d = String(raw || '').replace(/[^\d]/g, '');
  if (d.length < 7 || d.length > 15) return null;
  return `+${d}`;
}

function expiresIn(date) {
  const ms = new Date(date).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'Expired';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m left`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h left`;
  return `${Math.round(h / 24)}d left`;
}

function hashTone(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}

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
  const [shareFor, setShareFor] = useState(null); // { numberId? }
  const [confirm, setConfirm] = useState(null);
  const [users, setUsers] = useState({ loading: true, error: '', list: [] });

  // CRM users — fetched once per panel; used for avatar chips and the assignment picker.
  useEffect(() => {
    let alive = true;
    routingApi(locationId)
      .users()
      .then((list) => alive && setUsers({ loading: false, error: '', list: Array.isArray(list) ? list : [] }))
      .catch((err) => alive && setUsers({ loading: false, error: err.message || 'Could not load users.', list: [] }));
    return () => {
      alive = false;
    };
  }, [locationId]);

  const usersById = useMemo(() => new Map(users.list.map((u) => [String(u.id), u])), [users.list]);

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
        <div className={`lc-usage ${atLimit ? 'full' : ''}`}>
          <div className="lc-usage-main">
            <span className="lc-usage-k">Plan usage</span>
            <span className="lc-usage-v">
              <b className="tnum">{occupying}</b> of {plural(limit, 'number')} in use
            </span>
          </div>
          <div className={`lc-usage-meter ${limit > 12 ? 'bar' : ''}`} aria-hidden="true">
            {limit > 12 ? (
              <span className="on" style={{ width: `${Math.min(100, (occupying / limit) * 100)}%` }} />
            ) : (
              Array.from({ length: Math.max(limit, 1) }, (_, i) => <span key={i} className={i < occupying ? 'on' : ''} />)
            )}
          </div>
          {lockedReason && (
            <div className="lc-usage-note">
              <Icon name="lock" size={13} />
              {lockedReason}
            </div>
          )}
        </div>
      )}

      <div className="numbers-grid" style={compact ? { gridTemplateColumns: '1fr' } : undefined}>
        {numbers.map((n) => (
          <NumberCard
            key={n.id}
            n={n}
            usersById={usersById}
            canManage={canManage}
            onRelink={() => setConnect(n)}
            onResume={() => run(() => api.resume(n.id), 'Reconnecting…')}
            onPause={() => run(() => api.pause(n.id), 'Number paused')}
            onDefault={() => run(() => api.update(n.id, { isDefault: true }), 'Default number updated')}
            onSettings={() => setSettingsFor(n)}
            onGroups={() => setGroupsFor(n)}
            onShare={() => setShareFor({ numberId: n.id })}
            onUnlink={() =>
              setConfirm({
                title: 'Unlink this number?',
                body: (
                  <>
                    <b>
                      {numberName(n)}
                      {n.phoneNumber ? ` (${formatPhone(n.phoneNumber)})` : ''}
                    </b>{' '}
                    will be logged out from WhatsApp Web and removed. Past messages stay in Conversations. You can link it again anytime.
                  </>
                ),
                label: 'Unlink number',
                fn: () => run(() => api.unlink(n.id), 'Number unlinked'),
              })
            }
          />
        ))}

        <div className="nm-add-wrap">
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
          {linkable && (
            <button type="button" className="nm-add-share" onClick={() => setShareFor({})}>
              <Icon name="send" size={14} />
              <span>
                <b>Share connect link</b>
                <span className="muted"> · let the phone’s owner scan it themselves</span>
              </span>
            </button>
          )}
        </div>
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
          n={numbers.find((x) => x.id === settingsFor.id) || settingsFor}
          locationId={locationId}
          isAgency={isAgency}
          users={users}
          onClose={() => setSettingsFor(null)}
          onSave={(patch) => run(() => api.update(settingsFor.id, patch), 'Settings saved')}
          onApplyProxy={() => run(() => proxyApi(locationId).apply(settingsFor.id), 'Reconnecting through the new proxy…')}
        />
      )}
      {groupsFor && (
        <GroupsModal
          n={numbers.find((x) => x.id === groupsFor.id) || groupsFor}
          locationId={locationId}
          onClose={() => setGroupsFor(null)}
          onEnableSync={() => run(() => api.update(groupsFor.id, { settings: { syncGroups: true } }), 'Group sync turned on')}
          onChanged={onChanged}
        />
      )}
      {shareFor && <ShareLinkModal locationId={locationId} numbers={numbers} initialNumberId={shareFor.numberId || ''} onClose={() => setShareFor(null)} />}
      {confirm && (
        <Confirm title={confirm.title} danger confirmLabel={confirm.label} onConfirm={confirm.fn} onClose={() => setConfirm(null)}>
          {confirm.body}
        </Confirm>
      )}
    </>
  );
}

// ── Number card ─────────────────────────────────────────────────────

function NumberCard({ n, usersById, canManage, onRelink, onResume, onPause, onDefault, onSettings, onGroups, onShare, onUnlink }) {
  const base = statusMeta(n.status, n.pausedReason);
  const meta = n.status === 'disconnected' && n.reconnectAttempt > 0 ? { ...base, label: `Reconnecting (attempt ${n.reconnectAttempt})` } : base;
  const dim = n.status !== 'connected';
  const relink = NEEDS_RELINK.has(n.status);
  const proxy = n.settings?.proxyCountry;
  const secondary = n.label || n.waName;
  const assigned = n.assignedUserIds || [];
  const inboundOff = n.settings?.disableIncoming;

  return (
    <div className={`card ncard lc-ncard tone-${meta.tone} ${dim ? 'dim' : ''}`}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="wa">
          <WaGlyph size={24} />
          <span className={`lc-wa-dot ${meta.tone} ${LIVE.has(n.status) ? 'live' : ''}`} aria-hidden="true" />
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row nm-title" style={{ gap: 6 }}>
            <span className="phone">{numberName(n)}</span>
            {n.isDefault && <span className="default-tag">Default</span>}
            {n.settings?.syncGroups && (
              <span className="grp-tag" title="WhatsApp groups sync to the CRM">
                <Icon name="users" size={11} />
                Groups
              </span>
            )}
            {proxy && (
              <span className="nm-flag" title={`Connects through a proxy in ${countryName(proxy)}`}>
                <span className="nm-flag-emoji" aria-hidden="true">
                  {flagEmoji(proxy)}
                </span>
                {proxy.toUpperCase()}
              </span>
            )}
          </div>
          {secondary && (
            <div className="nm-label" title={n.waName && n.label ? `WhatsApp name: ${n.waName}` : undefined}>
              {secondary}
            </div>
          )}
          <div className={`nm-phone ${n.phoneNumber ? '' : 'empty'}`}>{n.phoneNumber ? formatPhone(n.phoneNumber) : 'Not linked yet'}</div>
        </div>
        {canManage && (
          <Menu
            items={[
              { label: 'Settings', icon: 'sliders', onClick: onSettings },
              n.status === 'connected' && { label: 'WhatsApp groups', icon: 'users', onClick: onGroups },
              !n.isDefault && n.status === 'connected' && { label: 'Make default', icon: 'star', onClick: onDefault },
              n.status === 'connected' && { label: 'Pause', icon: 'pause', onClick: onPause },
              (n.status === 'paused' || n.status === 'disconnected') && { label: 'Reconnect', icon: 'play', onClick: onResume },
              n.status !== 'connected' && { label: 'Share link', icon: 'send', onClick: onShare },
              '-',
              { label: 'Unlink number', icon: 'unlink', danger: true, onClick: onUnlink },
            ]}
          />
        )}
      </div>

      <div className="row lc-ncard-status" style={{ justifyContent: 'space-between', gap: 8 }}>
        <Pill tone={meta.tone} dot live={LIVE.has(n.status)}>
          {meta.label}
        </Pill>
        <span className="muted lc-ncard-when" style={{ fontSize: 12, textAlign: 'right' }}>
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

      {(assigned.length > 0 || inboundOff) && (
        <div className="nm-foot">
          {assigned.length > 0 ? (
            <div className="nm-assignees">
              <AvatarStack ids={assigned} usersById={usersById} />
              <span className="muted">{assignedSummary(assigned, usersById)}</span>
            </div>
          ) : (
            <span />
          )}
          {inboundOff && (
            <span className="nm-mini-tag warn" title="Incoming messages on this number don’t sync to the CRM">
              Inbound off
            </span>
          )}
        </div>
      )}

      {n.lastError && n.status !== 'connected' && <div className="err-note">{n.lastError}</div>}

      {canManage && (relink || ((n.status === 'paused' || n.status === 'disconnected') && n.pausedReason !== 'agency_disabled' && n.pausedReason !== 'plan_limit')) && (
        <div className="lc-ncard-actions">
          {relink && (
            <Button variant="primary" icon="qr" onClick={onRelink}>
              Link again
            </Button>
          )}
          {(n.status === 'paused' || n.status === 'disconnected') && n.pausedReason !== 'agency_disabled' && n.pausedReason !== 'plan_limit' && (
            <Button icon="play" onClick={onResume}>
              Reconnect
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function userLabel(u) {
  return u?.name || u?.email || 'Unknown user';
}

function assignedSummary(ids, usersById) {
  const first = usersById.get(String(ids[0]));
  const name = first ? userLabel(first).split(' ')[0] : null;
  if (!name) return `Assigned to ${plural(ids.length, 'user')}`;
  return ids.length === 1 ? `Assigned to ${name}` : `${name} +${ids.length - 1}`;
}

function UserAvatar({ user, id, size = 'sm' }) {
  const label = user ? userLabel(user) : 'Unknown user';
  return (
    <span className={`nm-av nm-av-${size} nm-tone-${hashTone(id)}`} title={user?.email && user?.name ? `${user.name} · ${user.email}` : label}>
      {user ? initials(user.name || user.email) : '?'}
    </span>
  );
}

function AvatarStack({ ids, usersById, max = 4 }) {
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <span className="nm-stack">
      {shown.map((id) => (
        <UserAvatar key={id} id={id} user={usersById.get(String(id))} />
      ))}
      {rest > 0 && (
        <span
          className="nm-av nm-av-sm nm-av-more"
          title={ids
            .slice(max)
            .map((id) => userLabel(usersById.get(String(id))))
            .join(', ')}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}

// ── Number settings ─────────────────────────────────────────────────

const SYNC_ROWS = [
  ['syncPhoneReplies', 'Sync replies sent from the phone', 'Messages you type in the WhatsApp app also appear in Conversations.'],
  ['typingSimulation', 'Show “typing…” before sending', 'Makes automated replies look natural and lowers the risk of restrictions.'],
  ['markRead', 'Mark messages as read', 'Customers see blue ticks as soon as a message syncs to the CRM.'],
];

const sameList = (a = [], b = []) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

function NumberSettings({ n, locationId, isAgency, users, onClose, onSave, onApplyProxy }) {
  const initial = n.settings || {};
  const [label, setLabel] = useState(n.label || '');
  const [assigned, setAssigned] = useState(() => (n.assignedUserIds || []).map(String));
  const [s, setS] = useState(() => ({
    ...initial,
    groupMode: initial.groupMode || 'all',
    blacklist: initial.blacklist || [],
    proxyCountry: initial.proxyCountry || '',
    callLogging: initial.callLogging !== false,
    missedCallMessage: initial.missedCallMessage || '',
  }));
  const [section, setSection] = useState('general');
  const [busy, setBusy] = useState(false);
  const [applyPrompt, setApplyPrompt] = useState(null); // null | 'live' | 'later'
  const [applying, setApplying] = useState(false);
  const [proxy, setProxy] = useState({ loading: true, enabled: false, countries: [], error: '' });
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    let alive = true;
    proxyApi(locationId)
      .countries()
      .then((r) => alive && setProxy({ loading: false, enabled: !!r?.enabled, countries: r?.countries || [], error: '' }))
      .catch((err) => alive && setProxy({ loading: false, enabled: false, countries: [], error: err.message || 'Could not load proxy locations.' }));
    return () => {
      alive = false;
    };
  }, [locationId]);

  const dirty = {
    general: label !== (n.label || ''),
    routing: !sameList(assigned, (n.assignedUserIds || []).map(String)),
    inbound: !!s.doNotCreateContacts !== !!initial.doNotCreateContacts || !!s.disableIncoming !== !!initial.disableIncoming || !sameList(s.blacklist, initial.blacklist || []),
    sync: SYNC_ROWS.some(([k]) => !!s[k] !== !!initial[k]) || !!s.syncGroups !== !!initial.syncGroups || s.groupMode !== (initial.groupMode || 'all'),
    calls:
      s.callLogging !== (initial.callLogging !== false) ||
      !!s.autoRejectCalls !== !!initial.autoRejectCalls ||
      !!s.missedCallReply !== !!initial.missedCallReply ||
      s.missedCallMessage !== (initial.missedCallMessage || ''),
    connection: s.proxyCountry !== (initial.proxyCountry || ''),
    pace: isAgency && ((s.minDelayMs ?? '') !== (initial.minDelayMs ?? '') || (s.dailyLimit ?? '') !== (initial.dailyLimit ?? '')),
  };
  const anyDirty = Object.values(dirty).some(Boolean);

  const sections = [
    { id: 'general', label: 'General', icon: 'settings' },
    { id: 'routing', label: 'Routing', icon: 'users', count: assigned.length || null },
    { id: 'inbound', label: 'Inbound', icon: 'arrowIn' },
    { id: 'sync', label: 'Sync', icon: 'refresh' },
    { id: 'calls', label: 'Calls', icon: 'phone' },
    { id: 'connection', label: 'Connection', icon: 'shield' },
    isAgency && { id: 'pace', label: 'Sending pace', icon: 'sliders' },
  ].filter(Boolean);

  const save = async () => {
    setBusy(true);
    const settings = {
      markRead: !!s.markRead,
      typingSimulation: !!s.typingSimulation,
      syncPhoneReplies: !!s.syncPhoneReplies,
      syncGroups: !!s.syncGroups,
      groupMode: s.groupMode === 'selected' ? 'selected' : 'all',
      doNotCreateContacts: !!s.doNotCreateContacts,
      disableIncoming: !!s.disableIncoming,
      blacklist: s.blacklist,
      proxyCountry: s.proxyCountry || '',
      callLogging: !!s.callLogging,
      autoRejectCalls: !!s.autoRejectCalls,
      missedCallReply: !!s.missedCallReply,
      missedCallMessage: s.missedCallMessage || '',
    };
    if (isAgency) {
      settings.minDelayMs = s.minDelayMs === '' ? null : s.minDelayMs;
      settings.dailyLimit = s.dailyLimit === '' ? null : s.dailyLimit;
    }
    const r = await onSave({ label, assignedUserIds: assigned, settings });
    setBusy(false);
    if (!r) return;
    if (dirty.connection) setApplyPrompt(APPLIABLE.has(n.status) ? 'live' : 'later');
    else onClose();
  };

  if (applyPrompt) {
    const live = applyPrompt === 'live';
    return (
      <Modal
        title="Proxy saved"
        subtitle={`${numberName(n)}${n.phoneNumber ? ` · ${formatPhone(n.phoneNumber)}` : ''}`}
        onClose={onClose}
        footer={
          live ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                Later
              </Button>
              <Button
                variant="primary"
                icon="refresh"
                loading={applying}
                onClick={async () => {
                  setApplying(true);
                  await onApplyProxy();
                  setApplying(false);
                  onClose();
                }}
              >
                Apply now
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          )
        }
      >
        <div className="nm-apply">
          <div className="nm-apply-ic">
            {s.proxyCountry ? <span aria-hidden="true">{flagEmoji(s.proxyCountry)}</span> : <Icon name="shield" size={22} />}
          </div>
          <div>
            <div className="nm-apply-t">{s.proxyCountry ? `Connect through ${countryName(s.proxyCountry)}` : 'Connect directly, without a proxy'}</div>
            <div className="muted">
              {live
                ? 'The new route takes effect the next time this number reconnects. Apply now to restart the connection — it’s back within a few seconds, and messages sent meanwhile are queued, not lost.'
                : 'This number isn’t connected right now, so the new route is used automatically the next time it connects.'}
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      wide
      title="Number settings"
      subtitle={`${numberName(n)}${n.phoneNumber ? ` · ${formatPhone(n.phoneNumber)}` : ''}${n.label ? ` · ${n.label}` : ''}`}
      onClose={onClose}
      footer={
        <>
          {anyDirty && <span className="nm-unsaved">Unsaved changes</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!anyDirty} onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="nm-set">
        <nav className="nm-set-nav" aria-label="Settings sections">
          {sections.map((x) => (
            <button key={x.id} type="button" className={section === x.id ? 'active' : ''} aria-current={section === x.id ? 'page' : undefined} onClick={() => setSection(x.id)}>
              <Icon name={x.icon} size={15} />
              <span className="grow">{x.label}</span>
              {x.count != null && <span className="nm-set-count">{x.count}</span>}
              {dirty[x.id] && <span className="nm-dirty" title="Unsaved changes" />}
            </button>
          ))}
        </nav>

        <div className="nm-set-body">
          {section === 'general' && (
            <SectionHead title="General" desc="How this number appears to your team across the app and in Conversations.">
              <Field label="Label" hint={`Shown under “${numberName(n)}”, e.g. the team or line this number belongs to.`}>
                <input className="input" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Sales line" autoFocus />
              </Field>
              <div className="nm-kv">
                <div>
                  <span>Number</span>
                  <b>{numberName(n)}</b>
                </div>
                <div>
                  <span>Phone</span>
                  <b className="tnum">{n.phoneNumber ? formatPhone(n.phoneNumber) : '—'}</b>
                </div>
                <div>
                  <span>WhatsApp name</span>
                  <b>{n.waName || '—'}</b>
                </div>
              </div>
            </SectionHead>
          )}

          {section === 'routing' && (
            <SectionHead title="Assigned users" desc="Who handles conversations on this number.">
              <UserPicker users={users} value={assigned} onChange={setAssigned} />
              <div className="nm-help">
                <Icon name="info" size={14} />
                <span>
                  When an assigned user replies from Conversations, the message goes out from this number. New chats arriving here are assigned to these
                  users. Leave empty to use the default number and the CRM’s normal assignment.
                </span>
              </div>
            </SectionHead>
          )}

          {section === 'inbound' && (
            <SectionHead title="Inbound" desc="Control which incoming messages reach the CRM.">
              <div>
                <SettingRow
                  t="Do not create new contacts"
                  d="Only chats with people who already exist as contacts sync. Messages from unknown numbers aren’t added to the CRM."
                  on={!!s.doNotCreateContacts}
                  onChange={(v) => set('doNotCreateContacts', v)}
                />
                <SettingRow
                  t="Disable incoming messages"
                  d="Nothing received on this number syncs to Conversations. You can still send from the CRM and workflows."
                  on={!!s.disableIncoming}
                  onChange={(v) => set('disableIncoming', v)}
                  warn
                />
              </div>
              {s.disableIncoming && (
                <Banner tone="warn" icon="alert" title="Incoming messages will be ignored">
                  Customer replies won’t show in Conversations and won’t trigger workflows while this is on.
                </Banner>
              )}
              <BlacklistEditor value={s.blacklist} onChange={(v) => set('blacklist', v)} />
            </SectionHead>
          )}

          {section === 'sync' && (
            <SectionHead title="Sync" desc="What syncs between the phone and the CRM.">
              <div>
                {SYNC_ROWS.map(([k, t, d]) => (
                  <SettingRow key={k} t={t} d={d} on={!!s[k]} onChange={(v) => set(k, v)} />
                ))}
                <SettingRow
                  t="Sync WhatsApp groups"
                  d="Each group becomes one CRM contact (“👥 Group name”). Messages show who wrote them, and replies from Conversations go to the whole group."
                  on={!!s.syncGroups}
                  onChange={(v) => set('syncGroups', v)}
                />
              </div>
              {s.syncGroups && (
                <div className="nm-subcard">
                  <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div>
                      <div className="nm-subcard-t">Which groups</div>
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        {s.groupMode === 'selected' ? 'Only groups you switch on in “WhatsApp groups” sync.' : 'Every group this number is in syncs, except ones you switch off.'}
                      </div>
                    </div>
                    <Segmented
                      value={s.groupMode}
                      onChange={(v) => set('groupMode', v)}
                      options={[
                        { value: 'all', label: 'All groups' },
                        { value: 'selected', label: 'Only selected' },
                      ]}
                    />
                  </div>
                </div>
              )}
            </SectionHead>
          )}

          {section === 'calls' && (
            <SectionHead title="Calls" desc="WhatsApp calls to this number. Calls ring on the phone — linked devices can’t carry call audio — and are logged here.">
              <div>
                <SettingRow
                  t="Log calls in Conversations"
                  d="Answered, declined and missed WhatsApp calls appear on the contact’s conversation, and fire the “WhatsApp call received” trigger."
                  on={!!s.callLogging}
                  onChange={(v) => set('callLogging', v)}
                />
                <SettingRow
                  t="Decline calls automatically"
                  d="For chat-only businesses: incoming WhatsApp calls are declined straight away (they’re still logged)."
                  on={!!s.autoRejectCalls}
                  onChange={(v) => set('autoRejectCalls', v)}
                  warn
                />
                <SettingRow
                  t="Reply to missed calls"
                  d="Send a WhatsApp message after a missed or declined call — at most once every 30 minutes per contact."
                  on={!!s.missedCallReply}
                  onChange={(v) => set('missedCallReply', v)}
                />
              </div>
              {s.missedCallReply && (
                <Field label="Missed-call message" hint="Variables like {{first_name|there}} work here.">
                  <textarea
                    className="textarea"
                    value={s.missedCallMessage}
                    maxLength={1000}
                    onChange={(e) => set('missedCallMessage', e.target.value)}
                    placeholder="Sorry we missed your call! Reply here and we’ll get back to you shortly."
                  />
                </Field>
              )}
              {s.missedCallReply && !String(s.missedCallMessage || '').trim() && (
                <Banner tone="warn" icon="alert" title="Write a message">
                  Missed-call replies are on, but the message is empty, so nothing will be sent.
                </Banner>
              )}
            </SectionHead>
          )}

          {section === 'connection' && (
            <SectionHead title="Connection" desc="Route this number through a proxy in a specific country, so WhatsApp sees a consistent local IP.">
              <Field label="Proxy country">
                {proxy.loading ? (
                  <Skeleton h={38} r={10} />
                ) : (
                  <select
                    className="input nm-select"
                    value={s.proxyCountry}
                    disabled={!proxy.enabled && !s.proxyCountry}
                    onChange={(e) => set('proxyCountry', e.target.value)}
                  >
                    <option value="">No proxy — connect directly</option>
                    {proxy.countries.map((c) => (
                      <option key={c.code} value={c.code} disabled={!c.count && c.code !== s.proxyCountry}>
                        {flagEmoji(c.code)} {c.name || countryName(c.code)}
                        {c.count != null ? ` · ${plural(c.count, 'proxy', 'proxies')}` : ''}
                      </option>
                    ))}
                    {s.proxyCountry && !proxy.countries.some((c) => c.code === s.proxyCountry) && (
                      <option value={s.proxyCountry}>
                        {flagEmoji(s.proxyCountry)} {countryName(s.proxyCountry)} · unavailable
                      </option>
                    )}
                  </select>
                )}
              </Field>
              {!proxy.loading && (proxy.error || !proxy.enabled) && (
                <div className="nm-muted-note">
                  <Icon name="info" size={14} />
                  {proxy.error ? proxy.error : 'No proxies configured. Ask your agency to add proxies to route numbers through a specific country.'}
                </div>
              )}
              {!proxy.loading && proxy.enabled && (
                <div className="nm-help">
                  <Icon name="info" size={14} />
                  <span>Pick the country the phone’s SIM is from. After saving you can apply the change right away — the connection restarts in a few seconds.</span>
                </div>
              )}
            </SectionHead>
          )}

          {section === 'pace' && isAgency && (
            <SectionHead title="Sending pace" desc="Agency only. Slower, capped sending keeps numbers healthy and reduces the risk of WhatsApp restrictions." badge="Agency">
              <div className="nm-two">
                <Field label="Min. delay between sends (ms)" hint="Blank = agency default">
                  <input className="input tnum" type="number" min={300} value={s.minDelayMs ?? ''} onChange={(e) => set('minDelayMs', e.target.value === '' ? '' : Number(e.target.value))} />
                </Field>
                <Field label="Daily send limit" hint="Blank = agency default">
                  <input className="input tnum" type="number" min={1} value={s.dailyLimit ?? ''} onChange={(e) => set('dailyLimit', e.target.value === '' ? '' : Number(e.target.value))} />
                </Field>
              </div>
            </SectionHead>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SectionHead({ title, desc, badge, children }) {
  return (
    <section className="nm-sec">
      <header>
        <h4>
          {title}
          {badge && <span className="nm-badge">{badge}</span>}
        </h4>
        {desc && <p>{desc}</p>}
      </header>
      <div className="stack" style={{ gap: 14 }}>
        {children}
      </div>
    </section>
  );
}

function SettingRow({ t, d, on, onChange, warn }) {
  return (
    <div className={`setting-row ${warn && on ? 'nm-row-warn' : ''}`}>
      <div>
        <div className="t">{t}</div>
        <div className="d">{d}</div>
      </div>
      <Toggle on={on} onChange={onChange} label={t} />
    </div>
  );
}

function UserPicker({ users, value, onChange }) {
  const [q, setQ] = useState('');
  const selected = new Set(value.map(String));
  const term = q.trim().toLowerCase();
  const list = users.list.filter((u) => !term || `${u.name || ''} ${u.email || ''} ${u.role || ''}`.toLowerCase().includes(term));
  const byId = new Map(users.list.map((u) => [String(u.id), u]));
  const toggle = (id) => onChange(selected.has(id) ? value.filter((x) => String(x) !== id) : [...value, id]);

  return (
    <div className="nm-picker">
      <div className="nm-picker-sel">
        {value.length ? (
          value.map((id) => {
            const u = byId.get(String(id));
            return (
              <span className="nm-chip" key={id}>
                <UserAvatar id={id} user={u} size="xs" />
                {u ? userLabel(u) : 'Unknown user'}
                <button type="button" aria-label={`Remove ${u ? userLabel(u) : 'user'}`} onClick={() => toggle(String(id))}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            );
          })
        ) : (
          <span className="muted" style={{ fontSize: 13 }}>
            No one assigned — default routing applies.
          </span>
        )}
        {value.length > 0 && (
          <button type="button" className="nm-linkbtn" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
      <div className="input-icon">
        <Icon name="search" size={15} />
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users by name or email" aria-label="Search users" />
      </div>
      <div className="nm-picker-list" role="listbox" aria-multiselectable="true">
        {users.loading ? (
          [0, 1, 2].map((i) => (
            <div className="nm-user" key={i}>
              <Skeleton h={28} w={28} r={8} />
              <div className="grow stack" style={{ gap: 5 }}>
                <Skeleton h={12} w="40%" />
                <Skeleton h={10} w="55%" />
              </div>
            </div>
          ))
        ) : users.error ? (
          <div className="nm-picker-empty">{users.error}</div>
        ) : !list.length ? (
          <div className="nm-picker-empty">{term ? `No users match “${q}”.` : 'No users found in this sub-account.'}</div>
        ) : (
          list.map((u) => {
            const id = String(u.id);
            const on = selected.has(id);
            return (
              <button type="button" role="option" aria-selected={on} className={`nm-user ${on ? 'on' : ''}`} key={id} onClick={() => toggle(id)}>
                <UserAvatar id={id} user={u} />
                <span className="grow nm-user-txt">
                  <b>{userLabel(u)}</b>
                  {u.email && u.name && <span>{u.email}</span>}
                </span>
                {u.role && <span className="nm-role">{u.role}</span>}
                <span className={`nm-check ${on ? 'on' : ''}`}>{on && <Icon name="check" size={12} stroke={3} />}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function BlacklistEditor({ value, onChange }) {
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const inputRef = useRef(null);

  const add = (raw) => {
    const parts = String(raw || '')
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    let bad = 0;
    let dup = 0;
    for (const p of parts) {
      const e = toE164(p);
      if (!e) bad++;
      else if (next.includes(e)) dup++;
      else next.push(e);
    }
    if (next.length !== value.length) onChange(next);
    const msgs = [];
    if (bad) msgs.push(`${plural(bad, 'entry', 'entries')} skipped — not a valid phone number`);
    if (dup) msgs.push(`${plural(dup, 'duplicate')} ignored`);
    setNote(msgs.join(' · '));
    setDraft('');
  };

  return (
    <div className="field">
      <label>Blacklisted numbers</label>
      <div className="nm-chipbox" onClick={() => inputRef.current?.focus()}>
        {value.map((p) => (
          <span className="nm-chip mono" key={p}>
            {formatPhone(p)}
            <button
              type="button"
              aria-label={`Remove ${p}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((x) => x !== p));
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={draft}
          placeholder={value.length ? 'Add another…' : '+447700900123'}
          aria-label="Add a blacklisted number"
          onChange={(e) => {
            setNote('');
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData?.getData('text') || '';
            if (/[\s,;]/.test(text.trim())) {
              e.preventDefault();
              add(`${draft} ${text}`);
            }
          }}
          onBlur={() => draft.trim() && add(draft)}
        />
      </div>
      <div className="hint nm-chip-hint">
        <span>
          Messages from these numbers are ignored and never reach the CRM. Use international format (E.164), e.g. <span className="mono">+447700900123</span>. Paste a
          list to add several at once.
        </span>
        {value.length > 0 && (
          <span className="nm-chip-count">
            {plural(value.length, 'number')}
            <button type="button" className="nm-linkbtn" onClick={() => onChange([])}>
              Clear all
            </button>
          </span>
        )}
      </div>
      {note && <div className="nm-chip-note">{note}</div>}
    </div>
  );
}

// ── Share connect link ──────────────────────────────────────────────

const EXPIRY = [
  { value: 24, label: '24 hours' },
  { value: 72, label: '3 days' },
  { value: 168, label: '7 days' },
];

function ShareLinkModal({ locationId, numbers, initialNumberId, onClose }) {
  const sapi = useMemo(() => shareApi(locationId), [locationId]);
  const act = useAction();
  const toast = useToast();
  const [numberId, setNumberId] = useState(initialNumberId);
  const [label, setLabel] = useState('');
  const [hours, setHours] = useState(72);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const [links, setLinks] = useState({ loading: true, list: [], error: '' });
  const [revoking, setRevoking] = useState(null); // id awaiting confirmation
  const [revokeBusy, setRevokeBusy] = useState(null);
  const urlRef = useRef(null);

  const relinkable = numbers.filter((n) => n.status !== 'connected');
  const nameOf = (id) => {
    const n = numbers.find((x) => x.id === id);
    return n ? `${numberName(n)}${n.phoneNumber ? ` · ${formatPhone(n.phoneNumber)}` : ''}` : 'Removed number';
  };

  const loadLinks = useCallback(async () => {
    try {
      const list = await sapi.list();
      setLinks({ loading: false, list: Array.isArray(list) ? list : [], error: '' });
    } catch (err) {
      setLinks({ loading: false, list: [], error: err.message || 'Could not load links.' });
    }
  }, [sapi]);

  useEffect(() => {
    loadLinks();
  }, [loadLinks]);

  // Pending or mid-scan, not yet connected and not expired.
  const active = links.list.filter((l) => (l.state ? l.state !== 'connected' : !l.usedAt) && new Date(l.expiresAt).getTime() > Date.now());
  const url = created ? shareUrl(created) : '';

  const create = async () => {
    setBusy(true);
    const r = await act(() => sapi.create({ ...(numberId ? { numberId } : {}), ...(label.trim() ? { label: label.trim() } : {}), expiresHours: hours }));
    setBusy(false);
    if (!r) return;
    setCreated(r);
    setCopied(false);
    setCopyFallback(false);
    loadLinks();
  };

  const selectUrl = () => {
    const el = urlRef.current;
    if (!el) return;
    el.focus();
    el.select();
    el.setSelectionRange?.(0, el.value.length);
  };

  const copy = async () => {
    if (!url) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      /* blocked inside the CRM iframe — fall through */
    }
    if (!ok) {
      selectUrl();
      try {
        ok = document.execCommand?.('copy') === true;
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      setCopyFallback(false);
      toast('Link copied');
      setTimeout(() => setCopied(false), 2200);
    } else {
      selectUrl();
      setCopyFallback(true);
    }
  };

  const revoke = async (id) => {
    setRevokeBusy(id);
    const r = await act(() => sapi.revoke(id), 'Link revoked');
    setRevokeBusy(null);
    setRevoking(null);
    if (r !== undefined) setLinks((x) => ({ ...x, list: x.list.filter((l) => l.id !== id) }));
  };

  return (
    <Modal
      title="Share a connect link"
      subtitle="Send it to whoever holds the phone — they scan the QR code on their own device, no CRM login needed."
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="stack" style={{ gap: 18 }}>
        {created ? (
          <div className="nm-share-done">
            <div className="row" style={{ gap: 10 }}>
              <span className="nm-share-ok">
                <Icon name="check" size={16} stroke={3} />
              </span>
              <div className="grow">
                <div style={{ fontWeight: 650 }}>Link ready</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {created.numberId ? `Re-links ${nameOf(created.numberId)}` : 'Links a new number'} · {expiresIn(created.expiresAt)} · works once
                </div>
              </div>
            </div>
            <div className="nm-url">
              <input ref={urlRef} className="input mono" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Connect link" />
              <Button variant={copied ? 'secondary' : 'primary'} icon={copied ? 'check' : 'copy'} onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            {copyFallback && <div className="nm-chip-note">Your browser blocked copying here — the link is selected, press ⌘C / Ctrl+C to copy it.</div>}
            <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span className="muted" style={{ fontSize: 12.5 }}>
                For security the full link is only shown now.
              </span>
              <button type="button" className="nm-linkbtn" onClick={() => setCreated(null)}>
                Create another link
              </button>
            </div>
          </div>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            <Field label="Number">
              <select className="input nm-select" value={numberId} onChange={(e) => setNumberId(e.target.value)}>
                <option value="">A new number</option>
                {relinkable.map((n) => (
                  <option key={n.id} value={n.id}>
                    Re-link {numberName(n)}
                    {n.phoneNumber ? ` · ${formatPhone(n.phoneNumber)}` : n.label ? ` · ${n.label}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <div className="nm-two">
              <Field label="Label (optional)" hint="Only your team sees this.">
                <input className="input" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Sarah’s phone" />
              </Field>
              <Field label="Expires after">
                <Segmented value={hours} onChange={setHours} options={EXPIRY} />
              </Field>
            </div>
            <Button variant="primary" icon="send" loading={busy} onClick={create} className="nm-share-create">
              Create link
            </Button>
          </div>
        )}

        <div>
          <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Active links</span>
            {!links.loading && active.length > 0 && <span>{active.length}</span>}
          </div>
          {links.loading ? (
            <div className="nm-links">
              {[0, 1].map((i) => (
                <div className="nm-link" key={i}>
                  <div className="grow stack" style={{ gap: 6 }}>
                    <Skeleton h={12} w="40%" />
                    <Skeleton h={10} w="60%" />
                  </div>
                </div>
              ))}
            </div>
          ) : links.error ? (
            <div className="nm-muted-note">
              <Icon name="alert" size={14} />
              {links.error}
            </div>
          ) : !active.length ? (
            <div className="nm-muted-note">
              <Icon name="info" size={14} />
              No active links. Links stop working once used, revoked or expired.
            </div>
          ) : (
            <div className="nm-links">
              {active.map((l) => (
                <div className="nm-link" key={l.id}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="nm-link-t">{l.label || (l.numberId ? `Re-link ${nameOf(l.numberId)}` : 'New number')}</div>
                    <div className="nm-link-m">
                      {l.label && <span>{l.numberId ? `Re-link ${nameOf(l.numberId)}` : 'New number'}</span>}
                      {l.state === 'in_progress' ? <span className="nm-exp live">Scanning now</span> : <span className="nm-exp">{expiresIn(l.expiresAt)}</span>}
                      {l.phoneNumber && <span className="tnum">{formatPhone(l.phoneNumber)}</span>}
                      {l.createdBy && <span>by {typeof l.createdBy === 'object' ? l.createdBy.name || l.createdBy.email || 'a teammate' : l.createdBy}</span>}
                    </div>
                  </div>
                  {revoking === l.id ? (
                    <div className="row" style={{ gap: 6 }}>
                      <Button size="sm" variant="ghost" onClick={() => setRevoking(null)} disabled={revokeBusy === l.id}>
                        Keep
                      </Button>
                      <Button size="sm" variant="danger-solid" loading={revokeBusy === l.id} onClick={() => revoke(l.id)}>
                        Revoke
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="danger" onClick={() => setRevoking(l.id)}>
                      Revoke
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── WhatsApp groups (feature: groups) ───────────────────────────────

function GroupsModal({ n, locationId, onClose, onEnableSync, onChanged }) {
  const gapi = useMemo(() => groupsApi(locationId), [locationId]);
  const act = useAction();
  const [state, setState] = useState({ loading: true, error: '', groups: [], syncGroups: !!n.settings?.syncGroups });
  const [mode, setMode] = useState(n.settings?.groupMode || 'all');
  const [modeBusy, setModeBusy] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all'); // all | on | off
  const [busy, setBusy] = useState(null); // jid being linked
  const [toggling, setToggling] = useState(() => new Set());
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (refresh) => {
      if (refresh) setRefreshing(true);
      try {
        const data = await gapi.list({ numberId: n.id, refresh });
        const row = data?.numbers?.[0];
        setState({ loading: false, error: row?.error || '', groups: row?.groups || [], syncGroups: !!row?.syncGroups });
        if (row?.groupMode) setMode(row.groupMode);
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
  // `enabled` is the server's effective state; fall back to explicit choice → mode.
  const isOn = (g) => (typeof g.enabled === 'boolean' ? g.enabled : typeof g.explicit === 'boolean' ? g.explicit : mode === 'all');
  const term = q.trim().toLowerCase();
  const shown = state.groups.filter(
    (g) => (!term || (g.subject || '').toLowerCase().includes(term)) && (filter === 'all' || (filter === 'on' ? isOn(g) : !isOn(g))),
  );
  const linkedCount = state.groups.filter((g) => g.mapped).length;
  const onCount = state.groups.filter(isOn).length;

  const changeMode = async (next) => {
    if (next === mode) return;
    const prev = mode;
    setMode(next);
    setModeBusy(true);
    const r = await act(
      () => loc(locationId).update(n.id, { settings: { groupMode: next } }),
      next === 'all' ? 'All groups now sync' : 'Only selected groups sync',
    );
    setModeBusy(false);
    if (!r) {
      setMode(prev);
      return;
    }
    // Groups without an explicit choice follow the mode.
    setState((x) => ({ ...x, groups: x.groups.map((g) => (g.explicit === true || g.explicit === false ? g : { ...g, enabled: next === 'all' })) }));
    onChanged?.();
  };

  const toggleGroup = async (g, enabled) => {
    setToggling((x) => new Set(x).add(g.jid));
    const r = await act(() => gapi.toggle(n.id, g.jid, enabled), `“${g.subject || 'Group'}” ${enabled ? 'will sync' : 'won’t sync'}`);
    setToggling((x) => {
      const y = new Set(x);
      y.delete(g.jid);
      return y;
    });
    if (r !== undefined) setState((x) => ({ ...x, groups: x.groups.map((y) => (y.jid === g.jid ? { ...y, enabled, explicit: enabled } : y)) }));
  };

  const link = async (g) => {
    setBusy(g.jid);
    const r = await act(() => gapi.link(g.jid, n.id), `“${g.subject || 'Group'}” linked to the CRM`);
    if (r) setState((x) => ({ ...x, groups: x.groups.map((y) => (y.jid === g.jid ? { ...y, mapped: true, contactId: r.contactId } : y)) }));
    setBusy(null);
  };

  const hint = (g) => {
    if (g.explicit === true) return { text: 'Explicitly enabled', tone: 'on' };
    if (g.explicit === false) return { text: 'Explicitly disabled', tone: 'off' };
    return { text: mode === 'all' ? 'On · follows “All groups”' : 'Off · not selected', tone: 'auto' };
  };

  return (
    <Modal
      wide
      title="WhatsApp groups"
      subtitle={`${numberName(n)}${n.phoneNumber ? ` · ${formatPhone(n.phoneNumber)}` : ''}${
        state.loading ? '' : ` · ${plural(state.groups.length, 'group')} · ${onCount} syncing · ${linkedCount} in CRM`
      }`}
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

        <div className={`nm-mode ${syncOn ? '' : 'muted-block'}`}>
          <div className="grow">
            <div className="nm-subcard-t">Sync mode</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {mode === 'all'
                ? 'Every group syncs automatically. Switch off the ones you don’t want in the CRM.'
                : 'Nothing syncs unless you switch it on below. New groups stay off until you pick them.'}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {modeBusy && <span className="spinner" style={{ width: 14, height: 14 }} />}
            <Segmented
              value={mode}
              onChange={changeMode}
              options={[
                { value: 'all', label: 'All groups' },
                { value: 'selected', label: 'Only selected' },
              ]}
            />
          </div>
        </div>

        <div className="grp-toolbar">
          <div className="input-icon grow">
            <Icon name="search" size={15} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups" aria-label="Search groups" />
          </div>
          {!state.loading && state.groups.length > 0 && (
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All', count: state.groups.length },
                { value: 'on', label: 'Syncing', count: onCount },
                { value: 'off', label: 'Off', count: state.groups.length - onCount },
              ]}
            />
          )}
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
            {term ? <>Nothing matches “{q}”.</> : 'No groups in this view.'}
          </Empty>
        ) : (
          <div className="grp-list">
            {shown.map((g) => {
              const on = isOn(g);
              const h = hint(g);
              return (
                <div className={`grp-row ${g.mapped ? 'linked' : ''} ${on ? '' : 'nm-grp-off'}`} key={g.jid}>
                  <div className="grp-av">
                    <Icon name="users" size={18} />
                  </div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="grp-name" title={g.subject}>
                      {g.subject || 'Untitled group'}
                    </div>
                    <div className="grp-meta">
                      <span className={`nm-ghint ${h.tone}`}>{h.text}</span>
                      <span>{plural(g.size || 0, 'member')}</span>
                      {g.isAdmin && <span className="grp-chip">Admin</span>}
                      {g.announce && <span className="grp-chip muted-chip" title="Only admins can send messages">Admins only</span>}
                      {g.lastActivityAt && <span>Active {timeAgo(g.lastActivityAt)}</span>}
                    </div>
                  </div>
                  {g.mapped ? (
                    <Pill tone={syncOn && on ? 'ok' : 'neutral'} dot>
                      {syncOn && on ? 'Syncing' : 'In CRM'}
                    </Pill>
                  ) : (
                    <Button size="sm" icon="plus" loading={busy === g.jid} disabled={!!busy && busy !== g.jid} onClick={() => link(g)}>
                      Link to CRM
                    </Button>
                  )}
                  <span className="nm-gtoggle" title={on ? 'Stop syncing this group' : 'Sync this group'}>
                    <Toggle on={on} disabled={toggling.has(g.jid)} onChange={(v) => toggleGroup(g, v)} label={`Sync ${g.subject || 'group'}`} />
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="muted grp-foot">
          Each linked group is one CRM contact tagged <b>whatsapp-group</b>. Group sends count toward this number’s daily limit.
        </div>
      </div>
    </Modal>
  );
}
