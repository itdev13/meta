import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { consentApi } from '../../lib/api-consent';
import { formatPhone, plural, timeAgo } from '../../lib/format';
import { Avatar, Banner, Button, Drawer, Empty, Field, Modal, Pill, Segmented, Skeleton, Toggle, useAction, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

const STATUS = {
  opted_in: { label: 'Opted in', tone: 'ok' },
  opted_out: { label: 'Opted out', tone: 'err' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

const METHOD = {
  inbound_message: 'First message',
  keyword: 'Keyword',
  workflow: 'Workflow',
  manual: 'Manual change',
  import: 'Import',
};

const ACTOR = { contact: 'Customer', user: 'Team member', workflow: 'Workflow', system: 'System' };

const DEFAULT_OUT = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'STOPALL'];
const DEFAULT_IN = ['START', 'UNSTOP', 'SUBSCRIBE', 'YES'];

const SETTING_KEYS = [
  'optOutKeywords',
  'optInKeywords',
  'optOutReplyEnabled',
  'optOutReply',
  'optInReplyEnabled',
  'optInReply',
  'implicitOptInOnInbound',
  'enforce',
  'tagOnOptOut',
  'optOutTag',
];

function pickSettings(s) {
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, s?.[k]]));
}

function fullDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function pct(v) {
  if (v == null) return '—';
  const p = v * 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

export default function ConsentPanel({ locationId }) {
  const capi = useMemo(() => consentApi(locationId), [locationId]);
  const [stats, setStats] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState('contacts');
  const [listKey, setListKey] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [csv, setCsv] = useState(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const act = useAction();

  const loadStats = useCallback(async () => {
    try {
      setStats(await capi.stats());
    } catch (err) {
      setError(err.message);
    }
  }, [capi]);

  const load = useCallback(async () => {
    try {
      const [st, se] = await Promise.all([capi.stats(), capi.settings()]);
      setStats(st);
      setSettings(se);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [capi]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshAll = () => {
    loadStats();
    setListKey((k) => k + 1);
  };

  const doExport = async () => {
    setExporting(true);
    const r = await act(() => capi.exportCsv());
    setExporting(false);
    if (r) setCsv(r);
  };

  if (error && !settings) {
    return (
      <div className="card">
        <Empty icon="alert" title="Couldn’t load consent" action={<Button onClick={load}>Try again</Button>}>
          {error}
        </Empty>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Consent &amp; compliance</h1>
          <p>Who agreed to hear from you on WhatsApp, who unsubscribed, and the full audit trail behind every change.</p>
        </div>
        <div className="row wrap">
          <Button icon="refresh" onClick={refreshAll}>
            Refresh
          </Button>
          <Button icon="arrowOut" loading={exporting} onClick={doExport}>
            Export CSV
          </Button>
        </div>
      </div>

      {stats ? <ConsentStats stats={stats} /> : <StatsSkeleton />}

      {settings ? <Explainer settings={settings} /> : <Skeleton h={128} r={16} />}

      <div className="cs-switch">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'contacts', label: 'Contacts', icon: 'users', count: stats?.total ?? null },
            { value: 'settings', label: 'Settings', icon: 'settings' },
          ]}
        />
      </div>

      {view === 'contacts' && (
        <ContactsCard
          capi={capi}
          stats={stats}
          refreshKey={listKey}
          onChanged={refreshAll}
          onRecord={() => setRecordOpen(true)}
        />
      )}

      {view === 'settings' &&
        (settings ? (
          <SettingsCard
            capi={capi}
            settings={settings}
            onSaved={(s) => {
              setSettings(s);
            }}
          />
        ) : (
          <Skeleton h={420} r={16} />
        ))}

      {csv && <ExportModal csv={csv} onClose={() => setCsv(null)} />}
      {recordOpen && (
        <RecordConsentModal
          capi={capi}
          onClose={() => setRecordOpen(false)}
          onDone={() => {
            setRecordOpen(false);
            refreshAll();
          }}
        />
      )}
    </>
  );
}

// ── KPIs ──────────────────────────────────────────────────────────

function ConsentStats({ stats }) {
  const { counts, optOuts30d, optIns30d, reached30d, optOutRate30d, series } = stats;
  const rateTone = optOutRate30d == null ? '' : optOutRate30d >= 0.05 ? 'danger' : optOutRate30d >= 0.02 ? 'attention' : '';
  return (
    <div className="stats">
      <div className="card stat">
        <div className="k">
          <Icon name="check" size={14} />
          Opted in
        </div>
        <div className="v">{counts.opted_in.toLocaleString()}</div>
        <div className="h">{optIns30d ? `+${optIns30d.toLocaleString()} in the last 30 days` : 'Can receive messages'}</div>
      </div>
      <div className={`card stat ${counts.opted_out ? 'danger' : ''}`}>
        <div className="k">
          <Icon name="lock" size={14} />
          Opted out
        </div>
        <div className="v">{counts.opted_out.toLocaleString()}</div>
        <div className="h">Messages to them are blocked</div>
      </div>
      <div className={`card stat cs-rate ${rateTone}`}>
        <div className="k">
          <Icon name="sliders" size={14} />
          Opt-out rate · 30d
        </div>
        <div className="cs-rate-row">
          <div>
            <div className="v">{pct(optOutRate30d)}</div>
            <div className="h">
              {reached30d ? `${plural(optOuts30d, 'opt-out')} of ${reached30d.toLocaleString()} messaged` : 'No messages sent yet'}
            </div>
          </div>
          <Sparkline series={series} />
        </div>
      </div>
    </div>
  );
}

function Sparkline({ series }) {
  const max = Math.max(1, ...series.map((d) => Math.max(d.optOuts, d.optIns)));
  const w = 4;
  const gap = 2;
  const h = 34;
  return (
    <svg className="cs-spark" width={series.length * (w + gap)} height={h} role="img" aria-label="Opt-ins and opt-outs per day, last 30 days">
      {series.map((d, i) => {
        const outH = d.optOuts ? Math.max(3, (d.optOuts / max) * (h - 2)) : 0;
        const inH = d.optIns ? Math.max(3, (d.optIns / max) * (h - 2)) : 0;
        return (
          <g key={d.date}>
            <title>{`${d.date}: ${d.optOuts} out · ${d.optIns} in`}</title>
            <rect x={i * (w + gap)} y={0} width={w} height={h} rx={2} className="bg" />
            {inH > 0 && <rect x={i * (w + gap)} y={h - inH} width={w} height={inH} rx={2} className="in" />}
            {outH > 0 && <rect x={i * (w + gap)} y={h - outH} width={w} height={outH} rx={2} className="out" />}
          </g>
        );
      })}
    </svg>
  );
}

function StatsSkeleton() {
  return (
    <div className="stats">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} h={104} r={16} />
      ))}
    </div>
  );
}

// ── Explainer ─────────────────────────────────────────────────────

function Explainer({ settings }) {
  const out = settings.optOutKeywords || [];
  const inn = settings.optInKeywords || [];
  const items = [
    {
      icon: 'shield',
      tone: settings.enforce ? 'ok' : 'warn',
      t: settings.enforce ? 'Opted-out contacts are blocked' : 'Blocking is off',
      d: settings.enforce
        ? 'Agents, workflows and auto-replies can’t message anyone who unsubscribed. The attempt fails with a clear reason.'
        : 'Opt-outs are still recorded, but messages to them will send. Turn blocking on in Settings.',
    },
    {
      icon: 'x',
      tone: 'err',
      t: 'One-word unsubscribe',
      d: (
        <>
          A message that is exactly {out.slice(0, 3).map((k, i) => (
            <span key={k}>
              {i > 0 && (i === Math.min(out.length, 3) - 1 ? ' or ' : ', ')}
              <span className="kbd">{k}</span>
            </span>
          ))}
          {out.length > 3 ? ` (+${out.length - 3} more)` : ''} unsubscribes the sender{settings.optOutReplyEnabled ? ' and gets a confirmation' : ''}.
        </>
      ),
    },
    {
      icon: 'check',
      tone: 'info',
      t: 'Resubscribe any time',
      d: (
        <>
          {inn.length ? (
            <>
              Replying <span className="kbd">{inn[0]}</span> after unsubscribing opts them back in.
            </>
          ) : (
            'Opt-in keywords are off; only your team or a workflow can opt someone back in.'
          )}
          {settings.implicitOptInOnInbound ? ' A customer who messages you first counts as opted in.' : ''}
        </>
      ),
    },
    {
      icon: 'copy',
      tone: 'neutral',
      t: 'Every change is logged',
      d: 'What caused it, who did it, when, and through which number. The log can’t be edited and can be exported as CSV.',
    },
  ];
  return (
    <div className="card cs-explainer">
      {items.map((it) => (
        <div className="cs-ex" key={it.t}>
          <div className={`cs-ex-ic ${it.tone}`}>
            <Icon name={it.icon} size={16} />
          </div>
          <div>
            <div className="t">{it.t}</div>
            <div className="d">{it.d}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Contacts ──────────────────────────────────────────────────────

function ContactsCard({ capi, stats, refreshKey, onChanged, onRecord }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => setPage(1), [status, debounced]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    capi
      .contacts({ status, q: debounced, page, limit: 25 })
      .then((d) => {
        if (!live) return;
        setData(d);
        setErr('');
      })
      .catch((e) => live && setErr(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [capi, status, debounced, page, refreshKey]);

  const c = stats?.counts;
  const items = data?.items || [];

  return (
    <div className="card">
      <div className="toolbar">
        <div className="input-icon cs-search">
          <Icon name="search" size={15} />
          <input className="input" placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: 'All', count: stats?.total ?? null },
            { value: 'opted_in', label: 'Opted in', count: c?.opted_in ?? null },
            { value: 'opted_out', label: 'Opted out', count: c?.opted_out ?? null },
            { value: 'unknown', label: 'Unknown', count: c?.unknown || null },
          ]}
        />
        <div className="grow" />
        <Button icon="plus" onClick={onRecord}>
          Record consent
        </Button>
      </div>

      {err && !data ? (
        <Empty icon="alert" title="Couldn’t load contacts">
          {err}
        </Empty>
      ) : !data && loading ? (
        <div className="stack" style={{ padding: 16 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} h={44} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Empty icon={debounced || status ? 'search' : 'shield'} title={debounced || status ? 'No matching contacts' : 'No consent activity yet'}>
          {debounced || status
            ? 'Try a different search or filter.'
            : 'Contacts appear here as soon as someone messages you, replies STOP, or a workflow or teammate records their consent.'}
        </Empty>
      ) : (
        <>
          <div className={`table-wrap ${loading ? 'cs-loading' : ''}`}>
            <table className="table cs-table">
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Last change</th>
                  <th>Since</th>
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const st = STATUS[r.status] || STATUS.unknown;
                  return (
                    <tr key={r._id} className="cs-row" onClick={() => setOpen(r)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(r)}>
                      <td>
                        <div className="row name-cell">
                          <Avatar name={r.name || r.phone} />
                          <div className="grow">
                            <div className="n">{r.name || formatPhone(r.phone) || 'Unknown contact'}</div>
                            <div className="s tnum">{r.name ? formatPhone(r.phone) || '—' : r.contactId ? 'No name' : 'Number only · not a contact yet'}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <Pill tone={st.tone} dot>
                          {st.label}
                        </Pill>
                      </td>
                      <td>
                        <div className="cs-method">{METHOD[r.lastMethod] || '—'}</div>
                      </td>
                      <td className="muted" title={fullDate(r.lastEventAt)}>
                        {timeAgo(r.lastEventAt)}
                      </td>
                      <td style={{ width: 40, color: 'var(--ink-4)' }}>
                        <Icon name="chevron" size={16} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.pages > 1 && (
            <div className="cs-pager">
              <span className="muted tnum">
                {(data.page - 1) * data.limit + 1}–{Math.min(data.page * data.limit, data.total)} of {data.total.toLocaleString()}
              </span>
              <div className="row">
                <Button size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button size="sm" disabled={page >= data.pages || loading} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {open && (
        <ContactDrawer
          capi={capi}
          row={open}
          onClose={() => setOpen(null)}
          onChanged={(contact) => {
            setOpen(contact);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function ContactDrawer({ capi, row, onClose, onChanged }) {
  const [log, setLog] = useState(null);
  const [err, setErr] = useState('');
  const id = row.contactId || row._id;

  const load = useCallback(async () => {
    try {
      setLog(await capi.log(id));
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, [capi, id]);

  useEffect(() => {
    load();
  }, [load]);

  const contact = log?.contact || row;
  const st = STATUS[contact.status] || STATUS.unknown;

  return (
    <Drawer
      onClose={onClose}
      header={
        <div className="row">
          <Avatar name={contact.name || contact.phone} size="lg" />
          <div className="grow">
            <div style={{ fontWeight: 700, fontSize: 15.5 }}>{contact.name || formatPhone(contact.phone) || 'Unknown contact'}</div>
            <div className="muted tnum" style={{ fontSize: 12.5 }}>
              {formatPhone(contact.phone) || 'No phone'}
            </div>
          </div>
          <Pill tone={st.tone} dot>
            {st.label}
          </Pill>
        </div>
      }
    >
      <div className="card cs-facts">
        <div>
          <div className="k">Opted in</div>
          <div className="v">{contact.optedInAt ? fullDate(contact.optedInAt) : '—'}</div>
        </div>
        <div>
          <div className="k">Opted out</div>
          <div className="v">{contact.optedOutAt ? fullDate(contact.optedOutAt) : '—'}</div>
        </div>
        <div>
          <div className="k">Last change</div>
          <div className="v">{METHOD[contact.lastMethod] || '—'}</div>
        </div>
        <div>
          <div className="k">GHL contact</div>
          <div className="v mono cs-id" title={contact.contactId || ''}>
            {contact.contactId || 'Not linked yet'}
          </div>
        </div>
      </div>

      <ManualChangeForm
        current={contact.status}
        onSubmit={async (status, note) => {
          const r = await capi.manual({ contactId: contact.contactId || undefined, phone: contact.contactId ? undefined : contact.phone, status, note });
          await load();
          onChanged(r.contact);
          return r;
        }}
      />

      <div>
        <div className="section-title">Consent log</div>
        {err && !log ? (
          <Banner tone="err" icon="alert" title="Couldn’t load the log">
            {err}
          </Banner>
        ) : !log ? (
          <div className="stack">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} h={58} r={12} />
            ))}
          </div>
        ) : log.events.length === 0 ? (
          <div className="card">
            <Empty icon="inbox" title="No events yet" />
          </div>
        ) : (
          <Timeline events={log.events} />
        )}
      </div>
    </Drawer>
  );
}

function eventTitle(e) {
  const verb = e.event === 'opted_out' ? 'Opted out' : 'Opted in';
  if (e.method === 'keyword') return `${verb} by replying ${e.keyword || 'a keyword'}`;
  if (e.method === 'inbound_message') return `${verb} by messaging first`;
  if (e.method === 'workflow') return `${verb} by a workflow`;
  if (e.method === 'manual') return `${verb} by ${e.actor?.name || 'a team member'}`;
  if (e.method === 'import') return `${verb} by import`;
  return verb;
}

function Timeline({ events }) {
  return (
    <ol className="cs-timeline">
      {events.map((e) => {
        const repeat = e.previousStatus === e.event;
        return (
          <li key={e._id} className={e.event === 'opted_out' ? 'out' : 'in'}>
            <span className="cs-tl-dot">
              <Icon name={e.event === 'opted_out' ? 'x' : 'check'} size={12} />
            </span>
            <div className="cs-tl-body">
              <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                <div className="t grow">{eventTitle(e)}</div>
                <span className="muted tnum" style={{ fontSize: 12, whiteSpace: 'nowrap' }} title={fullDate(e.createdAt)}>
                  {timeAgo(e.createdAt)}
                </span>
              </div>
              <div className="cs-tl-meta">
                <span>{fullDate(e.createdAt)}</span>
                <span>{ACTOR[e.actor?.type] || 'System'}{e.actor?.type === 'user' && e.actor?.email ? ` · ${e.actor.email}` : ''}</span>
                {e.linkedNumber && <span>via {formatPhone(e.linkedNumber)}</span>}
                {repeat && <span className="cs-tag">Already {STATUS[e.event]?.label.toLowerCase()}</span>}
              </div>
              {e.text && e.method !== 'keyword' && <div className="cs-quote">“{e.text}”</div>}
              {e.note && (
                <div className="cs-note">
                  <b>Reason:</b> {e.note}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ManualChangeForm({ current, onSubmit }) {
  const [status, setStatus] = useState(current === 'opted_out' ? 'opted_in' : 'opted_out');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction();

  useEffect(() => {
    setStatus(current === 'opted_out' ? 'opted_in' : 'opted_out');
  }, [current]);

  const same = status === current;
  const ok = note.trim().length >= 3;

  return (
    <div className="card card-pad stack cs-manual">
      <div>
        <div style={{ fontWeight: 700 }}>Change consent</div>
        <div className="muted" style={{ fontSize: 13 }}>
          Record a change the customer asked for by phone, email or in person. The reason is saved to the log.
        </div>
      </div>
      <Segmented
        value={status}
        onChange={setStatus}
        options={[
          { value: 'opted_in', label: 'Opt in', icon: 'check' },
          { value: 'opted_out', label: 'Opt out', icon: 'x' },
        ]}
      />
      {status === 'opted_in' && current === 'opted_out' && (
        <Banner tone="warn" icon="alert">
          Only opt someone back in if they asked you to. This customer unsubscribed.
        </Banner>
      )}
      <Field label="Reason (required)" hint={same ? `Already ${STATUS[current]?.label.toLowerCase()}, so this will only add a note to the log.` : undefined}>
        <textarea
          className="textarea"
          value={note}
          maxLength={500}
          placeholder={status === 'opted_out' ? 'Called on 4 Nov and asked us to stop messaging on WhatsApp.' : 'Signed the in-store consent form on 4 Nov.'}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant={status === 'opted_out' ? 'danger-solid' : 'primary'}
          loading={busy}
          disabled={!ok}
          onClick={async () => {
            setBusy(true);
            const r = await act(() => onSubmit(status, note.trim()), status === 'opted_out' ? 'Contact opted out' : 'Contact opted in');
            setBusy(false);
            if (r) setNote('');
          }}
        >
          {status === 'opted_out' ? 'Opt out contact' : 'Opt in contact'}
        </Button>
      </div>
    </div>
  );
}

function RecordConsentModal({ capi, onClose, onDone }) {
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState('opted_out');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction();
  const ok = phone.replace(/[^\d]/g, '').length >= 6 && note.trim().length >= 3;

  return (
    <Modal
      title="Record consent"
      subtitle="For a number that asked to opt out (or in) outside WhatsApp. It applies even before they become a contact."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={status === 'opted_out' ? 'danger-solid' : 'primary'}
            loading={busy}
            disabled={!ok}
            onClick={async () => {
              setBusy(true);
              const r = await act(() => capi.manual({ phone: phone.trim(), status, note: note.trim() }), 'Consent recorded');
              setBusy(false);
              if (r) onDone();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        <Field label="Phone number" hint="Include the country code, for example +1 415 555 0100.">
          <input className="input" value={phone} placeholder="+1 415 555 0100" onChange={(e) => setPhone(e.target.value)} autoFocus />
        </Field>
        <Field label="Consent">
          <Segmented
            value={status}
            onChange={setStatus}
            options={[
              { value: 'opted_out', label: 'Opt out', icon: 'x' },
              { value: 'opted_in', label: 'Opt in', icon: 'check' },
            ]}
          />
        </Field>
        <Field label="Reason (required)">
          <textarea className="textarea" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Asked by email on 4 Nov to stop WhatsApp messages." />
        </Field>
      </div>
    </Modal>
  );
}

// ── Settings ──────────────────────────────────────────────────────

function SettingsCard({ capi, settings, onSaved }) {
  const initial = useMemo(() => pickSettings(settings), [settings]);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const act = useAction();

  useEffect(() => setForm(initial), [initial]);

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const overlap = form.optOutKeywords.filter((k) => form.optInKeywords.includes(k));

  const save = async () => {
    setBusy(true);
    const r = await act(() => capi.saveSettings(form), 'Consent settings saved');
    setBusy(false);
    if (r) onSaved(r);
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card">
        <div className="card-head">
          <h3>Keywords</h3>
          <span className="muted" style={{ fontSize: 12.5 }}>
            Matched when the whole message is the word, any capitalisation
          </span>
        </div>
        <div className="card-pad cs-kw-grid">
          <KeywordEditor
            label="Unsubscribe (opt-out)"
            tone="out"
            value={form.optOutKeywords}
            onChange={set('optOutKeywords')}
            defaults={DEFAULT_OUT}
            hint="Always handled first: the message is not passed to auto-replies."
          />
          <KeywordEditor
            label="Resubscribe (opt-in)"
            tone="in"
            value={form.optInKeywords}
            onChange={set('optInKeywords')}
            defaults={DEFAULT_IN}
            hint="Consumed and confirmed only when the sender had unsubscribed; otherwise the message flows normally."
          />
        </div>
        {overlap.length > 0 && (
          <div style={{ padding: '0 20px 16px' }}>
            <Banner tone="err" icon="alert">
              <span className="kbd">{overlap[0]}</span> is in both lists. Remove it from one before saving.
            </Banner>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Confirmation replies</h3>
        </div>
        <div className="card-pad cs-replies">
          <ReplyEditor
            title="When someone unsubscribes"
            enabled={form.optOutReplyEnabled}
            onEnabled={set('optOutReplyEnabled')}
            text={form.optOutReply}
            onText={set('optOutReply')}
          />
          <ReplyEditor
            title="When someone resubscribes"
            enabled={form.optInReplyEnabled}
            onEnabled={set('optInReplyEnabled')}
            text={form.optInReply}
            onText={set('optInReply')}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Rules</h3>
        </div>
        <div className="card-pad" style={{ paddingTop: 4, paddingBottom: 4 }}>
          <div className="setting-row">
            <div>
              <div className="t">Block messages to opted-out contacts</div>
              <div className="d">Sends from Conversations, workflows and auto-replies fail with “This contact unsubscribed”. Recommended.</div>
            </div>
            <Toggle on={form.enforce} onChange={set('enforce')} label="Block messages to opted-out contacts" />
          </div>
          <div className="setting-row">
            <div>
              <div className="t">A customer messaging first counts as opt-in</div>
              <div className="d">Logged once, the first time an unknown contact writes to you.</div>
            </div>
            <Toggle on={form.implicitOptInOnInbound} onChange={set('implicitOptInOnInbound')} label="Implicit opt-in on inbound" />
          </div>
          <div className="setting-row">
            <div className="grow">
              <div className="t">Tag contacts who unsubscribe</div>
              <div className="d">Added in the CRM on opt-out and removed again on opt-in, so you can filter or exclude them anywhere.</div>
              {form.tagOnOptOut && (
                <input
                  className="input mono cs-tag-input"
                  value={form.optOutTag}
                  maxLength={60}
                  onChange={(e) => set('optOutTag')(e.target.value)}
                  placeholder="whatsapp-opted-out"
                />
              )}
            </div>
            <Toggle on={form.tagOnOptOut} onChange={set('tagOnOptOut')} label="Tag contacts on opt-out" />
          </div>
        </div>
      </div>

      {!form.enforce && (
        <Banner tone="warn" icon="alert" title="Blocking is off">
          Opt-outs are still logged, but messages to unsubscribed contacts will be delivered. That may break messaging rules in your region.
        </Banner>
      )}

      {dirty && (
        <div className="cs-savebar">
          <Icon name="info" size={16} />
          <span className="grow">You have unsaved changes</span>
          <Button variant="ghost" size="sm" onClick={() => setForm(initial)} disabled={busy}>
            Discard
          </Button>
          <Button variant="primary" size="sm" loading={busy} disabled={overlap.length > 0} onClick={save}>
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

function KeywordEditor({ label, tone, value, onChange, defaults, hint }) {
  const [draft, setDraft] = useState('');
  const ref = useRef(null);
  const isDefault = value.length === defaults.length && value.every((k) => defaults.includes(k));

  const add = (raw) => {
    const words = String(raw)
      .split(/[,\n]/)
      .map((w) => w.trim().replace(/^[\s"'.!?]+|[\s"'.!?]+$/g, '').toUpperCase())
      .filter((w) => w && w.length <= 30);
    if (!words.length) return;
    onChange([...value, ...words.filter((w, i) => !value.includes(w) && words.indexOf(w) === i)].slice(0, 25));
    setDraft('');
  };

  return (
    <div className="field">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label>{label}</label>
        {!isDefault && (
          <button type="button" className="cs-link" onClick={() => onChange([...defaults])}>
            Reset to defaults
          </button>
        )}
      </div>
      <div className={`cs-chips ${tone}`} onClick={() => ref.current?.focus()}>
        {value.map((k) => (
          <span className="cs-chip" key={k}>
            {k}
            <button type="button" aria-label={`Remove ${k}`} onClick={() => onChange(value.filter((x) => x !== k))}>
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        <input
          ref={ref}
          value={draft}
          placeholder={value.length ? 'Add…' : 'Type a word and press Enter'}
          onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => draft && add(draft)}
        />
      </div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function ReplyEditor({ title, enabled, onEnabled, text, onText }) {
  return (
    <div className={`cs-reply ${enabled ? '' : 'off'}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 650 }}>{title}</div>
        <Toggle on={enabled} onChange={onEnabled} label={title} />
      </div>
      <textarea className="textarea" value={text} maxLength={1000} disabled={!enabled} onChange={(e) => onText(e.target.value)} />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="cs-bubble">{text || 'Write a short confirmation…'}</div>
        <span className="muted tnum" style={{ fontSize: 11.5, alignSelf: 'flex-end' }}>
          {text.length}/1000
        </span>
      </div>
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────

function ExportModal({ csv, onClose }) {
  const toast = useToast();
  const [opened, setOpened] = useState(false);
  const rows = Math.max(0, csv.text.replace(/^﻿/, '').split('\n').filter(Boolean).length - 1);
  const areaRef = useRef(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(csv.text.replace(/^﻿/, ''));
      toast('CSV copied. Paste it into a spreadsheet.');
    } catch {
      areaRef.current?.select();
      toast('Copy was blocked. The text is selected: press Ctrl/Cmd + C.', 'err');
    }
  };

  const openTab = () => {
    try {
      const url = URL.createObjectURL(new Blob([csv.text], { type: 'text/csv;charset=utf-8' }));
      const w = window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (!w) throw new Error('blocked');
      setOpened(true);
    } catch {
      toast('Your browser blocked the new tab. Use “Copy CSV” instead.', 'err');
    }
  };

  return (
    <Modal
      wide
      title="Export consent log"
      subtitle={`${plural(rows, 'event')} · ${csv.filename}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button icon="external" onClick={openTab}>
            Open in new tab
          </Button>
          <Button variant="primary" icon="copy" onClick={copy}>
            Copy CSV
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="muted" style={{ fontSize: 13 }}>
          Downloads are blocked inside the CRM, so copy the CSV and paste it into Google Sheets or Excel, or open it in a new tab and save it from
          there.
          {opened ? ' If the new tab shows plain text, use File › Save as.' : ''}
        </div>
        <textarea ref={areaRef} className="textarea mono cs-csv" readOnly value={csv.text.replace(/^﻿/, '')} onFocus={(e) => e.target.select()} />
      </div>
    </Modal>
  );
}
