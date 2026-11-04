import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CATEGORIES,
  DAY_NAMES,
  STARTER_CONFIRM,
  STARTER_RULES,
  STARTER_TEMPLATES,
  VARIABLES,
  isOpenNow,
  keywordMatches,
  renderSample,
  rulesApi,
  timezones,
  variablesIn,
} from '../../lib/api-rules';
import { formatPhone, plural, timeAgo } from '../../lib/format';
import { Banner, Button, Confirm, Empty, Field, IconButton, Menu, Modal, Pill, Segmented, Skeleton, Toggle, useAction, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

// ── Constants & helpers ───────────────────────────────────────────

const MAX_TEXT = 4096;

const MATCH = {
  exact: { label: 'Exact', long: 'Exact match', hint: 'The whole message must be the keyword. “C”, “c” and “C!” match — “C please” doesn’t.' },
  contains: { label: 'Contains', long: 'Contains', hint: 'The keyword appears anywhere as a whole word. “price” matches “what’s the price?” but not “priceless”.' },
  starts_with: { label: 'Starts with', long: 'Starts with', hint: 'The message begins with the keyword. “book” matches “book me in Friday”.' },
};

const COMMON_TZ = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Bogota',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Amsterdam',
  'Europe/Rome',
  'Europe/Athens',
  'Europe/Istanbul',
  'Africa/Lagos',
  'Africa/Cairo',
  'Africa/Nairobi',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Jakarta',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Manila',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Perth',
  'Australia/Brisbane',
  'Australia/Sydney',
  'Pacific/Auckland',
];

// Monday-first display order; values are the API's Sunday-first indexes.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const COOLDOWN_PRESETS = [
  { v: 0, l: 'None' },
  { v: 15, l: '15 min' },
  { v: 60, l: '1 hour' },
  { v: 720, l: '12 hours' },
  { v: 1440, l: '1 day' },
];

const numberName = (n) => n?.label || formatPhone(n?.phoneNumber) || 'Number';
const cap = (s) => String(s || '').replace(/(^|[-_\s])(\w)/g, (_, p, c) => `${p === '-' || p === '_' ? ' ' : p}${c.toUpperCase()}`);

function cooldownLabel(min) {
  const m = Number(min) || 0;
  if (!m) return 'No cooldown';
  if (m < 60) return `${m} min`;
  if (m % 1440 === 0) return plural(m / 1440, 'day');
  if (m % 60 === 0) return plural(m / 60, 'hour');
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function useDebounced(value, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function useMinuteTick() {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
}

/** Light WhatsApp formatting (*bold*, _italic_, ~strike~) as React nodes — never raw HTML. */
function waFormat(text) {
  const src = String(text || '');
  const re = /(?<![\p{L}\p{N}])(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)(?![\p{L}\p{N}])/gu;
  const out = [];
  let last = 0;
  let i = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const t = m[0];
    const inner = t.slice(1, -1);
    out.push(t[0] === '*' ? <strong key={i++}>{inner}</strong> : t[0] === '_' ? <em key={i++}>{inner}</em> : <s key={i++}>{inner}</s>);
    last = m.index + t.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

const isImage = (url) => /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(String(url || ''));
const fileName = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop()) || url;
  } catch {
    return url;
  }
};
const nowTime = () => new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// ── Panel ─────────────────────────────────────────────────────────

export default function RulesPanel({ locationId, numbers = [] }) {
  const rapi = useMemo(() => rulesApi(locationId), [locationId]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState('rules');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await rapi.overview();
      setData({ rules: d.rules || [], templates: d.templates || [], settings: d.settings || null, stats: d.stats || null, hours: d.hours || null });
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [rapi]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = useCallback((key, value) => setData((d) => (d ? { ...d, [key]: typeof value === 'function' ? value(d[key]) : value } : d)), []);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const refreshHours = useCallback(() => {
    rapi
      .hours()
      .then((h) => patch('hours', h))
      .catch(() => {});
  }, [rapi, patch]);

  if (error && !data) {
    return (
      <div className="card">
        <Empty icon="alert" title="Couldn’t load auto-replies" action={<Button onClick={load}>Try again</Button>}>
          {error}
        </Empty>
      </div>
    );
  }

  const rules = data?.rules || [];
  const templates = data?.templates || [];
  const businessName = data?.settings?.businessName || '';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Auto-replies</h1>
          <p>Answer common messages instantly, tag contacts and start workflows from a keyword — plus an away message for after hours and a welcome for first-time customers.</p>
        </div>
        <div className="row wrap">
          <Button icon="refresh" loading={refreshing} onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {data ? <RuleStats data={data} /> : <StatsSkeleton />}

      <div className="ar-switch">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'rules', label: 'Keyword rules', icon: 'zap', count: data ? rules.length : null },
            { value: 'templates', label: 'Templates', icon: 'copy', count: data ? templates.length : null },
            { value: 'away', label: 'Away & welcome', icon: 'message' },
          ]}
        />
      </div>

      {!data && <ListSkeleton />}

      {data && view === 'rules' && (
        <RulesView
          rapi={rapi}
          rules={rules}
          templates={templates}
          stats={data.stats}
          numbers={numbers}
          businessName={businessName}
          onRules={(v) => patch('rules', v)}
          onStats={() => rapi.stats().then((s) => patch('stats', s)).catch(() => {})}
          onGoTemplates={() => setView('templates')}
        />
      )}

      {data && view === 'templates' && (
        <TemplatesView rapi={rapi} templates={templates} rules={rules} settings={data.settings} onTemplates={(v) => patch('templates', v)} />
      )}

      {data && view === 'away' && data.settings && (
        <AwayView
          rapi={rapi}
          settings={data.settings}
          hours={data.hours}
          templates={templates}
          numbers={numbers}
          businessName={businessName}
          onGoTemplates={() => setView('templates')}
          onSaved={(next) => {
            patch('settings', (s) => ({ ...s, ...next }));
            refreshHours();
          }}
        />
      )}
    </>
  );
}

// ── KPIs ──────────────────────────────────────────────────────────

function RuleStats({ data }) {
  const { rules, stats, hours, settings } = data;
  const active = rules.filter((r) => r.enabled).length;
  const totals = stats?.totals || { rules: 0, away: 0, welcome: 0 };
  const top = [...(stats?.rules || [])].sort((a, b) => b.hits30d - a.hits30d)[0];
  return (
    <div className="stats">
      <div className="card stat">
        <div className="k">
          <Icon name="zap" size={14} />
          Active rules
        </div>
        <div className="v">
          {active}
          <small>/ {rules.length}</small>
        </div>
        <div className="h">{rules.length ? 'Checked top to bottom' : 'No rules yet'}</div>
      </div>
      <div className="card stat">
        <div className="k">
          <Icon name="bolt" size={14} />
          Rules fired · 30d
        </div>
        <div className="v">{totals.rules.toLocaleString()}</div>
        <div className="h ar-ellipsis">{top?.hits30d ? `Top: ${top.name} (${top.hits30d.toLocaleString()})` : 'Keyword matches from customers'}</div>
      </div>
      <div className="card stat">
        <div className="k">
          <Icon name="pause" size={14} />
          Away replies · 30d
        </div>
        <div className="v">{totals.away.toLocaleString()}</div>
        <div className="h">
          {hours?.enabled ? (
            <span className={`ar-dotline ${hours.open ? 'open' : 'closed'}`}>
              <span className="ar-dot" />
              {hours.open ? 'Open now' : 'Closed now — away is replying'}
            </span>
          ) : (
            'Away message is off'
          )}
        </div>
      </div>
      <div className="card stat">
        <div className="k">
          <Icon name="star" size={14} />
          Welcomes · 30d
        </div>
        <div className="v">{totals.welcome.toLocaleString()}</div>
        <div className="h">{settings?.welcome?.enabled ? 'Greeting new contacts' : 'Welcome message is off'}</div>
      </div>
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="stats">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card stat">
          <Skeleton h={12} w={90} />
          <div style={{ height: 12 }} />
          <Skeleton h={26} w={60} />
          <div style={{ height: 8 }} />
          <Skeleton h={10} w={130} />
        </div>
      ))}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="card">
      <div className="card-head">
        <Skeleton h={16} w={160} />
        <Skeleton h={32} w={110} r={10} />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="ar-rule">
          <Skeleton h={52} w={28} r={8} />
          <div className="stack" style={{ gap: 8, flex: 1 }}>
            <Skeleton h={14} w="40%" />
            <Skeleton h={22} w="60%" />
            <Skeleton h={12} w="75%" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Shared building blocks ────────────────────────────────────────

function Bubble({ dir = 'out', children, media, time, muted }) {
  return (
    <div className={`ar-msg ${dir} ${muted ? 'muted' : ''}`}>
      {media &&
        (isImage(media) ? (
          <img className="ar-msg-img" src={media} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
        ) : (
          <div className="ar-msg-file">
            <Icon name="external" size={14} />
            <span className="ar-ellipsis">{fileName(media)}</span>
          </div>
        ))}
      {children}
      <span className="ar-msg-meta">
        {time || nowTime()}
        {dir === 'out' && <Icon name="check" size={12} />}
      </span>
    </div>
  );
}

function VarChips({ onInsert }) {
  return (
    <div className="ar-vars">
      {VARIABLES.map((v) => (
        <button key={v.key} type="button" className="ar-var" title={`Insert {{${v.key}}}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onInsert(`{{${v.key}}}`)}>
          <Icon name="plus" size={11} />
          {v.label}
        </button>
      ))}
    </div>
  );
}

function VarNote() {
  return (
    <div className="ar-varnote">
      <Icon name="info" size={13} />
      <span>
        Any contact field works too: <code>{'{{contact.company_name}}'}</code> or a custom field key. Add a fallback after a pipe —{' '}
        <code>{'{{first_name|there}}'}</code> shows “there” when the name is empty.
      </span>
    </div>
  );
}

function MessageEditor({ value, onChange, placeholder, rows = 5 }) {
  const ref = useRef(null);
  const sel = useRef(null);
  const remember = () => {
    const el = ref.current;
    if (el) sel.current = [el.selectionStart, el.selectionEnd];
  };
  const insert = (token) => {
    const [s, e] = sel.current || [value.length, value.length];
    const next = (value.slice(0, s) + token + value.slice(e)).slice(0, MAX_TEXT);
    onChange(next);
    const p = Math.min(s + token.length, next.length);
    sel.current = [p, p];
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(p, p);
      }
    });
  };
  return (
    <div className="ar-msgbox">
      <textarea
        ref={ref}
        className="textarea ar-textarea"
        rows={rows}
        value={value}
        maxLength={MAX_TEXT}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          sel.current = [e.target.selectionStart, e.target.selectionEnd];
        }}
        onSelect={remember}
        onKeyUp={remember}
        onClick={remember}
      />
      <div className="ar-msgbox-foot">
        <VarChips onInsert={insert} />
        <span className={`ar-count ${value.length > MAX_TEXT * 0.9 ? 'warn' : ''}`}>
          {value.length.toLocaleString()}/{MAX_TEXT.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

function ChipInput({ value, onChange, placeholder, transform = (s) => s, mono, tone = '', max = 30 }) {
  const [draft, setDraft] = useState('');
  const ref = useRef(null);
  const add = (raw) => {
    const words = String(raw)
      .split(/[,\n]/)
      .map((w) => transform(w.trim()))
      .filter(Boolean);
    if (!words.length) return;
    const next = [...value];
    for (const w of words) if (!next.includes(w) && next.length < max) next.push(w);
    onChange(next);
    setDraft('');
  };
  return (
    <div className={`ar-chips ${tone}`} onClick={() => ref.current?.focus()}>
      {value.map((k) => (
        <span key={k} className={`ar-chip ${mono ? 'mono' : ''}`}>
          {k}
          <button type="button" aria-label={`Remove ${k}`} onClick={() => onChange(value.filter((x) => x !== k))}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <input
        ref={ref}
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(',')) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          if (/[,\n]/.test(t)) {
            e.preventDefault();
            add(draft + t);
          }
        }}
      />
    </div>
  );
}

function NumberScope({ numbers, value, onChange }) {
  if (!numbers.length) return <div className="ar-hint">Applies to every WhatsApp number you link.</div>;
  const all = !value.length;
  return (
    <div className="ar-picks">
      <button type="button" className={`ar-pick ${all ? 'on' : ''}`} onClick={() => onChange([])}>
        <span className="ar-pick-box">{all && <Icon name="check" size={11} />}</span>
        All numbers
      </button>
      {numbers.map((n) => {
        const on = value.includes(n.id);
        return (
          <button key={n.id} type="button" className={`ar-pick ${on ? 'on' : ''}`} onClick={() => onChange(on ? value.filter((x) => x !== n.id) : [...value, n.id])}>
            <span className="ar-pick-box">{on && <Icon name="check" size={11} />}</span>
            <span className={`ar-status-dot ${n.status === 'connected' ? 'ok' : ''}`} />
            {numberName(n)}
          </button>
        );
      })}
    </div>
  );
}

function scopeLabel(sessionIds, numbers) {
  if (!sessionIds?.length) return 'All numbers';
  const names = sessionIds.map((id) => numbers.find((n) => n.id === id)).filter(Boolean).map(numberName);
  if (!names.length) return plural(sessionIds.length, 'number');
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
}

/** "Write a message" / "Use a template" (/ "No reply") with a live sample preview. */
function ReplySource({ mode, onMode, text, onText, templateId, onTemplate, templates, allowNone, businessName, placeholder, onGoTemplates, timezone }) {
  const tpl = templates.find((t) => t.id === templateId);
  const options = [
    { value: 'text', label: 'Write a message', icon: 'message' },
    { value: 'template', label: 'Use a template', icon: 'copy', count: templates.length },
    allowNone ? { value: 'none', label: 'No reply', icon: 'x' } : null,
  ].filter(Boolean);
  const previewText = mode === 'template' ? tpl?.body || '' : text;
  const previewMedia = mode === 'template' ? tpl?.mediaUrl : '';
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div>
        <Segmented value={mode} onChange={onMode} options={options} />
      </div>
      {mode === 'text' && (
        <>
          <MessageEditor value={text} onChange={onText} placeholder={placeholder} />
          <VarNote />
        </>
      )}
      {mode === 'template' &&
        (templates.length ? (
          <select className="select" value={templateId} onChange={(e) => onTemplate(e.target.value)}>
            <option value="">Choose a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {cap(t.category)}
              </option>
            ))}
          </select>
        ) : (
          <div className="ar-inline-note">
            <Icon name="info" size={14} />
            <span className="grow">You don’t have any templates yet.</span>
            {onGoTemplates && (
              <button type="button" className="ar-link" onClick={onGoTemplates}>
                Create one
              </button>
            )}
          </div>
        ))}
      {mode === 'none' && <div className="ar-hint">The rule still tags the contact and fires the workflow trigger — it just doesn’t send anything back.</div>}
      {mode !== 'none' && (previewText.trim() || previewMedia) && (
        <div className="ar-chat compact">
          <div className="ar-chat-label">Preview · sample contact</div>
          <Bubble dir="out" media={previewMedia}>
            <div className="ar-msg-text">{waFormat(renderSample(previewText, { businessName: businessName || 'Your business', timezone }))}</div>
          </Bubble>
        </div>
      )}
    </div>
  );
}

// ── Keyword rules ─────────────────────────────────────────────────

function RulesView({ rapi, rules, templates, stats, numbers, businessName, onRules, onStats, onGoTemplates }) {
  const act = useAction();
  const toast = useToast();
  const [editing, setEditing] = useState(null); // rule | 'new'
  const [deleting, setDeleting] = useState(null);
  const [moving, setMoving] = useState(null);
  const [installing, setInstalling] = useState(null);
  const hits30 = useMemo(() => Object.fromEntries((stats?.rules || []).map((r) => [r.ruleId, r])), [stats]);

  const move = async (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= rules.length) return;
    const prev = rules;
    const next = [...rules];
    [next[idx], next[j]] = [next[j], next[idx]];
    onRules(next.map((r, i) => ({ ...r, priority: i })));
    setMoving(rules[idx].id);
    try {
      onRules(await rapi.reorder(next.map((r) => r.id)));
    } catch (err) {
      onRules(prev);
      toast(err.message || 'Couldn’t reorder', 'err');
    } finally {
      setMoving(null);
    }
  };

  const setEnabled = async (rule, enabled) => {
    onRules((rs) => rs.map((r) => (r.id === rule.id ? { ...r, enabled } : r)));
    const r = await act(() => rapi.updateRule(rule.id, { enabled }), enabled ? `“${rule.name}” is on` : `“${rule.name}” is paused`);
    onRules((rs) => rs.map((x) => (x.id === rule.id ? r || { ...x, enabled: !enabled } : x)));
  };

  const install = async (key, list) => {
    setInstalling(key);
    const created = [];
    for (const body of list) {
      const r = await act(() => rapi.createRule(body));
      if (!r) break;
      created.push(r);
    }
    setInstalling(null);
    if (created.length) {
      onRules((rs) => [...rs, ...created]);
      toast(`Added ${plural(created.length, 'starter rule')}`);
    }
  };

  const tplName = (id) => templates.find((t) => t.id === id)?.name;

  return (
    <div className="ar-layout">
      <div className="card ar-rules-card">
        <div className="card-head">
          <div>
            <h3>Keyword rules</h3>
            <div className="ar-sub">Checked top to bottom — the first rule that matches wins.</div>
          </div>
          <div className="row">
            {rules.length > 0 && (
              <Menu
                trigger={(toggle) => (
                  <Button size="sm" icon="star" loading={!!installing} onClick={toggle}>
                    Starters
                  </Button>
                )}
                items={[
                  { label: 'Appointment confirm (C / R)', icon: 'check', onClick: () => install('confirm', STARTER_CONFIRM) },
                  { label: 'Pricing & opening hours', icon: 'message', onClick: () => install('faq', STARTER_RULES) },
                ]}
              />
            )}
            <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing('new')}>
              New rule
            </Button>
          </div>
        </div>

        {rules.length === 0 ? (
          <div className="ar-starter">
            <div className="ar-starter-ic">
              <Icon name="zap" size={22} />
            </div>
            <h4>Reply to keywords automatically</h4>
            <p>When a customer texts a keyword, reply instantly, tag them in the CRM and kick off a workflow. Start with a ready-made rule set or build your own.</p>
            <button type="button" className="ar-starter-card" disabled={!!installing} onClick={() => install('confirm', STARTER_CONFIRM)}>
              <div className="ar-starter-demo">
                <span className="ar-msg in mini">C</span>
                <Icon name="chevron" size={14} />
                <span className="ar-msg out mini">Confirmed ✅</span>
              </div>
              <div className="grow">
                <strong>Appointment confirm</strong>
                <span>
                  <span className="kbd">C</span> → confirm, <span className="kbd">R</span> → reschedule. Tags the contact and fires your workflow trigger.
                </span>
              </div>
              {installing === 'confirm' ? <span className="spinner" style={{ width: 16, height: 16 }} /> : <span className="ar-starter-cta">Add</span>}
            </button>
            <div className="row wrap" style={{ justifyContent: 'center', marginTop: 14 }}>
              <Button size="sm" icon="message" loading={installing === 'faq'} disabled={!!installing} onClick={() => install('faq', STARTER_RULES)}>
                Pricing &amp; hours starters
              </Button>
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setEditing('new')}>
                Start from scratch
              </Button>
            </div>
          </div>
        ) : (
          <ol className="ar-rule-list">
            {rules.map((r, i) => {
              const s = hits30[r.id];
              const tn = r.reply.mode === 'template' ? tplName(r.reply.templateId) : null;
              return (
                <li key={r.id} className={`ar-rule ${r.enabled ? '' : 'off'} ${moving === r.id ? 'moving' : ''}`}>
                  <div className="ar-order">
                    <button type="button" className="up" title="Move up" aria-label="Move up" disabled={i === 0 || !!moving} onClick={() => move(i, -1)}>
                      <Icon name="chevron" size={14} />
                    </button>
                    <span className="ar-prio tnum">{i + 1}</span>
                    <button type="button" className="down" title="Move down" aria-label="Move down" disabled={i === rules.length - 1 || !!moving} onClick={() => move(i, 1)}>
                      <Icon name="chevron" size={14} />
                    </button>
                  </div>

                  <div className="ar-rule-main" onClick={() => setEditing(r)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setEditing(r)}>
                    <div className="ar-rule-title">
                      <strong className="ar-ellipsis">{r.name}</strong>
                      <span className="ar-match">{MATCH[r.matchType]?.label || r.matchType}</span>
                      {!r.enabled && <Pill tone="neutral">Paused</Pill>}
                    </div>
                    <div className="ar-kws">
                      {r.keywords.slice(0, 8).map((k) => (
                        <span key={k} className="ar-kw">
                          {k}
                        </span>
                      ))}
                      {r.keywords.length > 8 && <span className="ar-kw more">+{r.keywords.length - 8}</span>}
                    </div>
                    <div className="ar-actions-line">
                      {r.reply.mode === 'text' && (
                        <span className="ar-act">
                          <Icon name="send" size={13} />
                          <span className="ar-ellipsis ar-quote">“{r.reply.text.replace(/\s+/g, ' ')}”</span>
                        </span>
                      )}
                      {r.reply.mode === 'template' && (
                        <span className={`ar-act ${tn ? '' : 'warn'}`}>
                          <Icon name={tn ? 'copy' : 'alert'} size={13} />
                          {tn ? `Template · ${tn}` : 'Template missing'}
                        </span>
                      )}
                      {r.reply.mode === 'none' && (
                        <span className="ar-act muted">
                          <Icon name="x" size={13} />
                          No reply
                        </span>
                      )}
                      {r.tags.length > 0 && (
                        <span className="ar-act">
                          <Icon name="key" size={13} />
                          {r.tags.slice(0, 2).join(', ')}
                          {r.tags.length > 2 ? ` +${r.tags.length - 2}` : ''}
                        </span>
                      )}
                      {r.fireTrigger && (
                        <span className="ar-act">
                          <Icon name="bolt" size={13} />
                          Workflow trigger
                        </span>
                      )}
                      <span className="ar-act muted">
                        <Icon name="refresh" size={13} />
                        {cooldownLabel(r.cooldownMinutes)}
                      </span>
                      {r.sessionIds.length > 0 && (
                        <span className="ar-act muted">
                          <Icon name="phone" size={13} />
                          {scopeLabel(r.sessionIds, numbers)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="ar-rule-hits">
                    <div className="n tnum">{r.hitCount.toLocaleString()}</div>
                    <div className="l">{s?.hits30d ? `${s.hits30d.toLocaleString()} in 30d` : r.hitCount === 1 ? 'hit' : 'hits'}</div>
                    <div className="l" title={r.lastTriggeredAt ? new Date(r.lastTriggeredAt).toLocaleString() : ''}>
                      {r.lastTriggeredAt ? `Last ${timeAgo(r.lastTriggeredAt)}` : 'Never fired'}
                    </div>
                  </div>

                  <div className="ar-rule-ctl">
                    <Toggle on={r.enabled} onChange={(v) => setEnabled(r, v)} label={`Enable ${r.name}`} />
                    <Menu
                      items={[
                        { label: 'Edit rule', icon: 'settings', onClick: () => setEditing(r) },
                        {
                          label: 'Duplicate',
                          icon: 'copy',
                          onClick: async () => {
                            const { id, hitCount, lastTriggeredAt, priority, createdAt, updatedAt, ...rest } = r;
                            const c = await act(() => rapi.createRule({ ...rest, name: `${r.name} (copy)`.slice(0, 80), enabled: false }), 'Duplicated — it starts paused');
                            if (c) onRules((rs) => [...rs, c]);
                          },
                        },
                        '-',
                        { label: 'Delete rule', icon: 'x', danger: true, onClick: () => setDeleting(r) },
                      ]}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <TestBox rapi={rapi} rules={rules} numbers={numbers} businessName={businessName} />

      {editing && (
        <RuleModal
          rapi={rapi}
          rule={editing === 'new' ? null : editing}
          templates={templates}
          numbers={numbers}
          businessName={businessName}
          onGoTemplates={() => {
            setEditing(null);
            onGoTemplates();
          }}
          onClose={() => setEditing(null)}
          onSaved={(saved, isNew) => {
            onRules((rs) => (isNew ? [...rs, saved] : rs.map((x) => (x.id === saved.id ? saved : x))));
            setEditing(null);
          }}
        />
      )}

      {deleting && (
        <Confirm
          title={`Delete “${deleting.name}”?`}
          confirmLabel="Delete rule"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const r = await act(() => rapi.deleteRule(deleting.id), 'Rule deleted');
            if (r) {
              onRules((rs) => rs.filter((x) => x.id !== deleting.id));
              onStats();
            }
          }}
        >
          Customers texting {deleting.keywords.slice(0, 3).map((k) => `“${k}”`).join(', ')}
          {deleting.keywords.length > 3 ? '…' : ''} will no longer get this auto-reply, tag or workflow trigger. This can’t be undone.
        </Confirm>
      )}
    </div>
  );
}

function TestBox({ rapi, rules, numbers, businessName }) {
  const [text, setText] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const q = useDebounced(text, 450);

  const run = useCallback(
    async (msg) => {
      const id = ++seq.current;
      if (!msg.trim()) {
        setResult(null);
        setError('');
        return;
      }
      setBusy(true);
      try {
        const r = await rapi.test({ text: msg, sessionId: sessionId || undefined });
        let reply = null;
        if (r.matched && r.rule?.reply?.mode && r.rule.reply.mode !== 'none') {
          const body = r.rule.reply.mode === 'template' ? { templateId: r.rule.reply.templateId } : { body: r.rule.reply.text };
          try {
            reply = await rapi.preview(body);
          } catch (err) {
            reply = { text: r.rule.reply.mode === 'text' ? renderSample(r.rule.reply.text, { businessName }) : '', error: err.message };
          }
        }
        if (id === seq.current) {
          setResult({ ...r, text: msg, reply });
          setError('');
        }
      } catch (err) {
        if (id === seq.current) setError(err.message);
      } finally {
        if (id === seq.current) setBusy(false);
      }
    },
    [rapi, sessionId, businessName],
  );

  useEffect(() => {
    run(q);
  }, [q, run, rules]);

  const samples = useMemo(() => {
    const out = [];
    for (const r of rules) {
      if (!r.enabled) continue;
      for (const k of r.keywords.slice(0, 2)) if (!out.includes(k) && out.length < 5) out.push(k);
    }
    return out;
  }, [rules]);

  const matched = result?.matched ? result.rule : null;

  return (
    <div className="card ar-test">
      <div className="card-head">
        <div>
          <h3>Test a message</h3>
          <div className="ar-sub">See which rule would fire — nothing is sent.</div>
        </div>
        {busy && <span className="spinner" style={{ width: 16, height: 16 }} />}
      </div>
      <div className="card-pad stack" style={{ gap: 12 }}>
        <div className="ar-test-input">
          <input
            className="input"
            value={text}
            placeholder="Type what a customer might send…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run(text)}
          />
          <Button variant="dark" icon="send" onClick={() => run(text)} disabled={!text.trim()}>
            Test
          </Button>
        </div>
        {numbers.length > 1 && (
          <select className="select" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            <option value="">Sent to any number</option>
            {numbers.map((n) => (
              <option key={n.id} value={n.id}>
                Sent to {numberName(n)}
              </option>
            ))}
          </select>
        )}
        {samples.length > 0 && !text && (
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="ar-hint">Try:</span>
            {samples.map((s) => (
              <button key={s} type="button" className="ar-kw btn-like" onClick={() => setText(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="ar-chat">
          {!result && !error && (
            <div className="ar-chat-empty">
              <Icon name="message" size={18} />
              Your test conversation shows here
            </div>
          )}
          {error && <div className="ar-chat-empty err">{error}</div>}
          {result && !error && (
            <>
              <Bubble dir="in">
                <div className="ar-msg-text">{result.text}</div>
              </Bubble>
              {matched && result.reply && (
                <Bubble dir="out" media={result.reply.mediaUrl}>
                  <div className="ar-msg-text">{waFormat(result.reply.text)}</div>
                </Bubble>
              )}
            </>
          )}
        </div>

        {result && !error && (
          <div className={`ar-verdict ${matched ? 'ok' : ''}`}>
            {matched ? (
              <>
                <div className="ar-verdict-t">
                  <Icon name="check" size={15} />
                  <span>
                    <b>{matched.name}</b> fires on <span className="ar-kw">{result.keyword}</span>
                  </span>
                </div>
                <ul className="ar-verdict-list">
                  <li>{matched.reply.mode === 'none' ? 'No reply is sent' : result.reply?.usingSample !== false ? 'Reply shown with a sample contact (Alex Morgan)' : 'Reply sent'}</li>
                  {matched.tags.length > 0 && <li>Adds tag{matched.tags.length > 1 ? 's' : ''}: {matched.tags.join(', ')}</li>}
                  {matched.fireTrigger && <li>Fires the “Keyword received” workflow trigger</li>}
                  <li>{matched.cooldownMinutes ? `Then waits ${cooldownLabel(matched.cooldownMinutes)} before replying to the same contact again` : 'Replies every time (no cooldown)'}</li>
                  {result.reply?.missing?.length > 0 && <li className="warn">Empty without a fallback: {result.reply.missing.map((m) => `{{${m}}}`).join(', ')}</li>}
                </ul>
              </>
            ) : (
              <div className="ar-verdict-t">
                <Icon name="info" size={15} />
                <span>No enabled rule matches. The message lands in Conversations as usual{' '}— outside business hours the away message may reply.</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RuleModal({ rapi, rule, templates, numbers, businessName, onClose, onSaved, onGoTemplates }) {
  const act = useAction();
  const [f, setF] = useState(() =>
    rule
      ? {
          name: rule.name,
          enabled: rule.enabled,
          matchType: rule.matchType,
          keywords: [...rule.keywords],
          sessionIds: [...rule.sessionIds],
          reply: { mode: rule.reply.mode, text: rule.reply.text, templateId: rule.reply.templateId },
          tags: [...rule.tags],
          fireTrigger: rule.fireTrigger,
          cooldownMinutes: rule.cooldownMinutes,
        }
      : {
          name: '',
          enabled: true,
          matchType: 'exact',
          keywords: [],
          sessionIds: [],
          reply: { mode: 'text', text: '', templateId: '' },
          tags: [],
          fireTrigger: true,
          cooldownMinutes: 60,
        },
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tryText, setTryText] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setReply = (k, v) => setF((x) => ({ ...x, reply: { ...x.reply, [k]: v } }));

  const tryHit = tryText.trim() ? f.keywords.find((k) => keywordMatches(f.matchType, tryText, k)) : null;

  const validate = () => {
    if (!f.name.trim()) return 'Give the rule a name.';
    if (!f.keywords.length) return 'Add at least one keyword.';
    if (f.reply.mode === 'text' && !f.reply.text.trim()) return 'Write the reply text, or choose “No reply”.';
    if (f.reply.mode === 'template' && !f.reply.templateId) return 'Choose a template for the reply.';
    return '';
  };

  const save = async () => {
    const v = validate();
    setErr(v);
    if (v) return;
    setBusy(true);
    const body = {
      ...f,
      name: f.name.trim(),
      cooldownMinutes: Math.max(0, Math.round(Number(f.cooldownMinutes) || 0)),
      reply: { mode: f.reply.mode, text: f.reply.mode === 'text' ? f.reply.text : '', templateId: f.reply.mode === 'template' ? f.reply.templateId : '' },
    };
    const r = await act(() => (rule ? rapi.updateRule(rule.id, body) : rapi.createRule(body)), rule ? 'Rule saved' : 'Rule created');
    setBusy(false);
    if (r) onSaved(r, !rule);
  };

  return (
    <Modal
      wide
      title={rule ? 'Edit keyword rule' : 'New keyword rule'}
      subtitle="When a customer sends a matching message, reply and update the CRM automatically."
      onClose={onClose}
      footer={
        <>
          <label className="ar-foot-toggle">
            <Toggle on={f.enabled} onChange={(v) => set('enabled', v)} label="Rule enabled" />
            {f.enabled ? 'Enabled' : 'Paused'}
          </label>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {rule ? 'Save rule' : 'Create rule'}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 22 }}>
        {err && (
          <Banner tone="err" icon="alert">
            {err}
          </Banner>
        )}

        <section className="ar-sec">
          <div className="ar-sec-h">
            <span className="ar-step">1</span>When a customer sends…
          </div>
          <div className="stack" style={{ gap: 14 }}>
            <Field label="Rule name">
              <input className="input" value={f.name} maxLength={80} placeholder="e.g. Confirm appointment" onChange={(e) => set('name', e.target.value)} autoFocus={!rule} />
            </Field>
            <Field label="Keywords" hint="Press Enter or comma to add. Not case-sensitive.">
              <ChipInput value={f.keywords} onChange={(v) => set('keywords', v)} placeholder="c, confirm, yes" transform={(s) => s.toLowerCase().replace(/\s+/g, ' ').slice(0, 100)} mono />
            </Field>
            <Field label="Match type" hint={MATCH[f.matchType].hint}>
              <div>
                <Segmented
                  value={f.matchType}
                  onChange={(v) => set('matchType', v)}
                  options={Object.entries(MATCH).map(([value, m]) => ({ value, label: m.long }))}
                />
              </div>
            </Field>
            {f.keywords.length > 0 && (
              <div className="ar-try">
                <input className="input" value={tryText} placeholder="Try a message against these keywords…" onChange={(e) => setTryText(e.target.value)} />
                {tryText.trim() && (
                  <span className={`ar-try-res ${tryHit ? 'ok' : ''}`}>
                    <Icon name={tryHit ? 'check' : 'x'} size={13} />
                    {tryHit ? `Matches “${tryHit}”` : 'No match'}
                  </span>
                )}
              </div>
            )}
            <Field label="On these numbers">
              <NumberScope numbers={numbers} value={f.sessionIds} onChange={(v) => set('sessionIds', v)} />
            </Field>
          </div>
        </section>

        <section className="ar-sec">
          <div className="ar-sec-h">
            <span className="ar-step">2</span>Reply with…
          </div>
          <ReplySource
            mode={f.reply.mode}
            onMode={(v) => setReply('mode', v)}
            text={f.reply.text}
            onText={(v) => setReply('text', v)}
            templateId={f.reply.templateId}
            onTemplate={(v) => setReply('templateId', v)}
            templates={templates}
            allowNone
            businessName={businessName}
            placeholder="Thanks {{first_name|there}}, you’re confirmed ✅"
            onGoTemplates={onGoTemplates}
          />
        </section>

        <section className="ar-sec">
          <div className="ar-sec-h">
            <span className="ar-step">3</span>And in the CRM…
          </div>
          <div className="stack" style={{ gap: 14 }}>
            <Field label="Add tags to the contact" hint="Optional. Use tags to filter contacts or start workflows.">
              <ChipInput value={f.tags} onChange={(v) => set('tags', v)} placeholder="appointment-confirmed" transform={(s) => s.slice(0, 60)} max={20} />
            </Field>
            <div className="ar-setting">
              <div className="grow">
                <div className="t">Fire the “Keyword received” workflow trigger</div>
                <div className="d">Lets a CRM workflow react to this rule — update an appointment, notify the team, start a sequence.</div>
              </div>
              <Toggle on={f.fireTrigger} onChange={(v) => set('fireTrigger', v)} label="Fire workflow trigger" />
            </div>
            <Field label="Cooldown per contact" hint={f.cooldownMinutes ? `A contact gets this auto-reply at most once every ${cooldownLabel(f.cooldownMinutes)}.` : 'Replies every time the keyword arrives.'}>
              <div className="row wrap" style={{ gap: 8 }}>
                <div className="ar-suffix">
                  <input
                    className="input tnum"
                    type="number"
                    min={0}
                    max={43200}
                    value={f.cooldownMinutes}
                    onChange={(e) => set('cooldownMinutes', e.target.value === '' ? '' : Math.max(0, Math.min(43200, Number(e.target.value))))}
                  />
                  <span>min</span>
                </div>
                {COOLDOWN_PRESETS.map((p) => (
                  <button key={p.v} type="button" className={`ar-preset ${Number(f.cooldownMinutes) === p.v ? 'on' : ''}`} onClick={() => set('cooldownMinutes', p.v)}>
                    {p.l}
                  </button>
                ))}
              </div>
            </Field>
          </div>
        </section>
      </div>
    </Modal>
  );
}

// ── Templates ─────────────────────────────────────────────────────

function TemplatesView({ rapi, templates, rules, settings, onTemplates }) {
  const act = useAction();
  const toast = useToast();
  const [editing, setEditing] = useState(null); // template | 'new'
  const [deleting, setDeleting] = useState(null);
  const [cat, setCat] = useState('all');
  const [installing, setInstalling] = useState(false);

  const cats = useMemo(() => [...new Set(templates.map((t) => t.category || 'general'))].sort(), [templates]);
  useEffect(() => {
    if (cat !== 'all' && !cats.includes(cat)) setCat('all');
  }, [cat, cats]);
  const shown = cat === 'all' ? templates : templates.filter((t) => (t.category || 'general') === cat);

  const usedBy = useCallback(
    (id) => {
      const u = rules.filter((r) => r.reply.mode === 'template' && r.reply.templateId === id).map((r) => `rule “${r.name}”`);
      if (settings?.away?.templateId === id) u.push('the away message');
      if (settings?.welcome?.templateId === id) u.push('the welcome message');
      return u;
    },
    [rules, settings],
  );

  const installStarters = async () => {
    setInstalling(true);
    const created = [];
    for (const t of STARTER_TEMPLATES) {
      if (templates.some((x) => x.name.toLowerCase() === t.name.toLowerCase())) continue;
      const r = await act(() => rapi.createTemplate(t));
      if (!r) break;
      created.push(r);
    }
    setInstalling(false);
    if (created.length) {
      onTemplates((ts) => [...ts, ...created]);
      toast(`Added ${plural(created.length, 'template')}`);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <h3>Message templates</h3>
            <div className="ar-sub">Reusable messages for rules, the away &amp; welcome replies, and the “Send WhatsApp template” workflow action.</div>
          </div>
          <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing('new')}>
            New template
          </Button>
        </div>

        {templates.length === 0 ? (
          <Empty
            icon="copy"
            title="No templates yet"
            action={
              <div className="row wrap" style={{ justifyContent: 'center' }}>
                <Button variant="primary" icon="star" loading={installing} onClick={installStarters}>
                  Add 3 starter templates
                </Button>
                <Button icon="plus" onClick={() => setEditing('new')}>
                  Write your own
                </Button>
              </div>
            }
          >
            Save the messages you send most — appointment reminders, follow-ups, “thanks for reaching out” — with personal details filled in automatically.
          </Empty>
        ) : (
          <>
            {cats.length > 1 && (
              <div className="toolbar">
                <div className="ar-cats">
                  {['all', ...cats].map((c) => (
                    <button key={c} type="button" className={`ar-preset ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>
                      {c === 'all' ? `All · ${templates.length}` : cap(c)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="ar-tpl-grid">
              {shown.map((t) => {
                const used = usedBy(t.id);
                const vars = variablesIn(t.body);
                return (
                  <div key={t.id} className="ar-tpl">
                    <div className="ar-tpl-top">
                      <span className={`ar-cat c-${(t.category || 'general').replace(/[^a-z-]/g, '')}`}>{cap(t.category)}</span>
                      {t.mediaUrl && (
                        <span className="ar-tpl-media" title={t.mediaUrl}>
                          <Icon name="external" size={12} />
                          Media
                        </span>
                      )}
                    </div>
                    <div className="ar-tpl-name">{t.name}</div>
                    <div className="ar-tpl-body">{t.body ? waFormat(t.body) : <span className="muted">Media only</span>}</div>
                    {vars.length > 0 && (
                      <div className="ar-tpl-vars">
                        {vars.slice(0, 4).map((v) => (
                          <code key={v}>{v}</code>
                        ))}
                        {vars.length > 4 && <code>+{vars.length - 4}</code>}
                      </div>
                    )}
                    <div className="ar-tpl-foot">
                      <span className="ar-tpl-meta" title={used.length ? `Used by ${used.join(', ')}` : ''}>
                        {used.length ? `In use · ${plural(used.length, 'place')}` : t.usageCount ? `Sent ${t.usageCount.toLocaleString()}×` : 'Not used yet'}
                        {t.lastUsedAt ? ` · ${timeAgo(t.lastUsedAt)}` : ''}
                      </span>
                      <div className="row" style={{ gap: 2 }}>
                        <IconButton icon="settings" title="Edit template" onClick={() => setEditing(t)} />
                        <IconButton icon="x" title="Delete template" onClick={() => setDeleting(t)} />
                      </div>
                    </div>
                  </div>
                );
              })}
              <button type="button" className="ar-tpl add" onClick={() => setEditing('new')}>
                <span className="ar-tpl-plus">
                  <Icon name="plus" size={18} />
                </span>
                New template
              </button>
            </div>
          </>
        )}
      </div>

      {editing && (
        <TemplateModal
          rapi={rapi}
          template={editing === 'new' ? null : editing}
          categories={[...new Set([...CATEGORIES, ...cats])]}
          onClose={() => setEditing(null)}
          onSaved={(saved, isNew) => {
            onTemplates((ts) => (isNew ? [...ts, saved] : ts.map((x) => (x.id === saved.id ? saved : x))));
            setEditing(null);
          }}
        />
      )}

      {deleting && (
        <Confirm
          title={`Delete “${deleting.name}”?`}
          confirmLabel="Delete template"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const r = await act(() => rapi.deleteTemplate(deleting.id), 'Template deleted');
            if (r) onTemplates((ts) => ts.filter((x) => x.id !== deleting.id));
          }}
        >
          {usedBy(deleting.id).length ? (
            <Banner tone="warn" icon="alert" title="This template is in use">
              It’s used by {usedBy(deleting.id).join(', ')}. Switch those to another message first, or the delete will be refused.
            </Banner>
          ) : (
            'Workflows that send this template by name will fail until you create a replacement. This can’t be undone.'
          )}
        </Confirm>
      )}
    </>
  );
}

function TemplateModal({ rapi, template, categories, onClose, onSaved }) {
  const act = useAction();
  const [f, setF] = useState(() => ({
    name: template?.name || '',
    category: template?.category || 'general',
    body: template?.body || '',
    mediaUrl: template?.mediaUrl || '',
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const dBody = useDebounced(f.body, 450);
  const dMedia = useDebounced(f.mediaUrl, 450);
  useEffect(() => {
    let live = true;
    if (!dBody.trim() && !dMedia.trim()) {
      setPreview(null);
      return undefined;
    }
    setPreviewing(true);
    rapi
      .preview({ body: dBody, mediaUrl: dMedia.trim() })
      .then((p) => live && setPreview(p))
      .catch((e) => live && setPreview({ text: renderSample(dBody), missing: [], error: e.message, mediaUrl: dMedia }))
      .finally(() => live && setPreviewing(false));
    return () => {
      live = false;
    };
  }, [rapi, dBody, dMedia]);

  const mediaBad = f.mediaUrl.trim() && !/^https?:\/\//i.test(f.mediaUrl.trim());
  const stale = dBody !== f.body || dMedia !== f.mediaUrl;

  const save = async () => {
    let v = '';
    if (!f.name.trim()) v = 'Give the template a name.';
    else if (!f.body.trim() && !f.mediaUrl.trim()) v = 'A template needs a message or a media URL.';
    else if (mediaBad) v = 'Media URL must start with http:// or https://';
    setErr(v);
    if (v) return;
    setBusy(true);
    const body = { name: f.name.trim(), category: f.category, body: f.body, mediaUrl: f.mediaUrl.trim() };
    const r = await act(() => (template ? rapi.updateTemplate(template.id, body) : rapi.createTemplate(body)), template ? 'Template saved' : 'Template created');
    setBusy(false);
    if (r) onSaved(r, !template);
  };

  return (
    <Modal
      wide
      title={template ? 'Edit template' : 'New template'}
      subtitle="Variables are filled in with each contact’s details when the message is sent."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {template ? 'Save template' : 'Create template'}
          </Button>
        </>
      }
    >
      {err && (
        <div style={{ marginBottom: 14 }}>
          <Banner tone="err" icon="alert">
            {err}
          </Banner>
        </div>
      )}
      <div className="ar-editor">
        <div className="stack" style={{ gap: 14 }}>
          <div className="ar-two">
            <Field label="Name">
              <input className="input" value={f.name} maxLength={80} placeholder="Appointment reminder" onChange={(e) => set('name', e.target.value)} autoFocus={!template} />
            </Field>
            <Field label="Category">
              <select className="select" value={f.category} onChange={(e) => set('category', e.target.value)}>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {cap(c)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Message">
            <MessageEditor value={f.body} onChange={(v) => set('body', v)} rows={8} placeholder={'Hi {{first_name|there}}, this is a reminder…\n\nUse *bold*, _italic_ and ~strike~ like in WhatsApp.'} />
          </Field>
          <VarNote />
          <Field label="Media URL (optional)" hint={mediaBad ? 'Must start with http:// or https://' : 'Public link to an image, PDF or video — sent with the message.'}>
            <input className="input" value={f.mediaUrl} placeholder="https://…/menu.pdf" onChange={(e) => set('mediaUrl', e.target.value)} />
          </Field>
        </div>

        <div className="ar-preview">
          <div className="ar-preview-head">
            <span>Live preview</span>
            {(previewing || stale) && (f.body.trim() || f.mediaUrl.trim()) ? <span className="spinner" style={{ width: 13, height: 13 }} /> : null}
          </div>
          <div className="ar-chat tall">
            {preview ? (
              <Bubble dir="out" media={preview.mediaUrl}>
                {preview.text ? <div className="ar-msg-text">{waFormat(preview.text)}</div> : null}
              </Bubble>
            ) : (
              <div className="ar-chat-empty">
                <Icon name="message" size={18} />
                Start typing to preview
              </div>
            )}
          </div>
          <div className="ar-preview-notes">
            {preview?.usingSample !== false && (
              <div>
                <Icon name="users" size={13} /> Sample contact: Alex Morgan{preview?.businessName ? ` · ${preview.businessName}` : ''}
              </div>
            )}
            {preview?.missing?.length > 0 && (
              <div className="warn">
                <Icon name="alert" size={13} /> Empty without a fallback: {preview.missing.map((m) => `{{${m}}}`).join(', ')}
              </div>
            )}
            {preview?.error && (
              <div className="warn">
                <Icon name="alert" size={13} /> Showing a local preview — {preview.error}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Away & welcome ────────────────────────────────────────────────

function toForm(settings) {
  const a = settings.away || {};
  const w = settings.welcome || {};
  return {
    away: {
      enabled: !!a.enabled,
      timezone: a.timezone || '',
      schedule: (a.schedule || []).map((d) => ({ open: !!d.open, start: d.start || '09:00', end: d.end || '17:00' })),
      mode: a.templateId ? 'template' : 'text',
      message: a.message || '',
      templateId: a.templateId || '',
      cooldownHours: a.cooldownHours ?? 12,
      sessionIds: a.sessionIds || [],
    },
    welcome: {
      enabled: !!w.enabled,
      mode: w.templateId ? 'template' : 'text',
      message: w.message || '',
      templateId: w.templateId || '',
      sessionIds: w.sessionIds || [],
    },
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function clockIn(tz) {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date());
  } catch {
    return '';
  }
}

function AwayView({ rapi, settings, hours, templates, numbers, businessName, onSaved, onGoTemplates }) {
  const act = useAction();
  const [initial, setInitial] = useState(() => toForm(settings));
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useMinuteTick();

  const setAway = (k, v) => setForm((f) => ({ ...f, away: { ...f.away, [k]: v } }));
  const setWelcome = (k, v) => setForm((f) => ({ ...f, welcome: { ...f.welcome, [k]: v } }));
  const setDay = (i, patch) => setForm((f) => ({ ...f, away: { ...f.away, schedule: f.away.schedule.map((d, j) => (j === i ? { ...d, ...patch } : d)) } }));

  const awayDirty = !same(form.away, initial.away);
  const welcomeDirty = !same(form.welcome, initial.welcome);
  const dirty = awayDirty || welcomeDirty;

  // Pick up refreshed settings from the panel (Refresh button) when there's nothing unsaved.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    const nf = toForm(settings);
    setInitial((cur) => (same(cur, nf) ? cur : nf));
    setForm((cur) => (same(cur, nf) ? cur : nf));
  }, [settings]);

  const locTz = settings.locationTimezone || '';
  const effTz = form.away.timezone || locTz || hours?.timezone || 'UTC';
  const openNow = isOpenNow(form.away.schedule, effTz);

  const tzOptions = useMemo(() => {
    const extra = [locTz, initial.away.timezone, hours?.timezone].filter(Boolean);
    const common = [...new Set([...COMMON_TZ, ...extra])];
    const rest = timezones().filter((z) => !common.includes(z));
    return { common, rest };
  }, [locTz, initial.away.timezone, hours?.timezone]);

  const preset = (kind) => {
    setForm((f) => {
      const s = f.away.schedule.map((d) => ({ ...d }));
      if (kind === 'weekdays') s.forEach((d, i) => Object.assign(d, { open: i >= 1 && i <= 5, start: '09:00', end: '17:00' }));
      if (kind === 'everyday') s.forEach((d) => Object.assign(d, { open: true, start: '09:00', end: '17:00' }));
      if (kind === 'copyMon') for (let i = 2; i <= 5; i++) s[i] = { ...s[1] };
      return { ...f, away: { ...f.away, schedule: s } };
    });
  };

  const save = async () => {
    const a = form.away;
    const w = form.welcome;
    let v = '';
    if (a.enabled && (a.mode === 'template' ? !a.templateId : !a.message.trim())) v = 'Write the away message (or pick a template) before turning it on.';
    else if (w.enabled && (w.mode === 'template' ? !w.templateId : !w.message.trim())) v = 'Write the welcome message (or pick a template) before turning it on.';
    else if (a.schedule.some((d) => d.open && (!d.start || !d.end))) v = 'Every open day needs an opening and closing time.';
    setErr(v);
    if (v) return;
    setBusy(true);
    const r = await act(async () => {
      const out = {};
      if (awayDirty) {
        out.away = await rapi.saveAway({
          enabled: a.enabled,
          timezone: a.timezone,
          schedule: a.schedule,
          message: a.message,
          templateId: a.mode === 'template' ? a.templateId : '',
          cooldownHours: Math.max(0, Number(a.cooldownHours) || 0),
          sessionIds: a.sessionIds,
        });
      }
      if (welcomeDirty) {
        out.welcome = await rapi.saveWelcome({
          enabled: w.enabled,
          message: w.message,
          templateId: w.mode === 'template' ? w.templateId : '',
          sessionIds: w.sessionIds,
        });
      }
      return out;
    }, 'Auto-replies saved');
    setBusy(false);
    if (r) {
      const next = { ...settings, ...r };
      const nf = toForm(next);
      // Keep the chosen text/template tab where the server can't tell (template mode with message kept).
      nf.away.mode = r.away ? nf.away.mode : form.away.mode;
      nf.welcome.mode = r.welcome ? nf.welcome.mode : form.welcome.mode;
      setInitial(nf);
      setForm(nf);
      onSaved(r);
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {err && (
        <Banner tone="err" icon="alert">
          {err}
        </Banner>
      )}

      <div className={`card ar-away ${form.away.enabled ? '' : 'is-off'}`}>
        <div className="card-head">
          <div className="row" style={{ gap: 12 }}>
            <div className="ar-head-ic">
              <Icon name="pause" size={17} />
            </div>
            <div>
              <h3>Away message</h3>
              <div className="ar-sub">Replies automatically when someone messages outside your business hours.</div>
            </div>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <span className={`ar-hours ${openNow ? 'open' : 'closed'}`} title={`Local time in ${effTz}`}>
              <span className="ar-dot" />
              {openNow ? 'Open now' : 'Closed now'}
              <span className="ar-hours-clock">{clockIn(effTz)}</span>
            </span>
            <Toggle on={form.away.enabled} onChange={(v) => setAway('enabled', v)} label="Away message enabled" />
          </div>
        </div>

        <div className="ar-away-grid">
          <div className="ar-away-col">
            <div className="ar-col-h">Business hours</div>
            <Field label="Timezone" hint={!form.away.timezone ? `Follows your sub-account timezone${locTz ? '' : ' (not set — using UTC)'}.` : null}>
              <select className="select" value={form.away.timezone} onChange={(e) => setAway('timezone', e.target.value)}>
                <option value="">Sub-account timezone{locTz ? ` (${locTz})` : ''}</option>
                <optgroup label="Common">
                  {tzOptions.common.map((z) => (
                    <option key={z} value={z}>
                      {z.replace(/_/g, ' ')}
                    </option>
                  ))}
                </optgroup>
                {tzOptions.rest.length > 0 && (
                  <optgroup label="All timezones">
                    {tzOptions.rest.map((z) => (
                      <option key={z} value={z}>
                        {z.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Field>

            <div className="row wrap" style={{ gap: 6 }}>
              <button type="button" className="ar-preset" onClick={() => preset('weekdays')}>
                Mon–Fri, 9–5
              </button>
              <button type="button" className="ar-preset" onClick={() => preset('everyday')}>
                Every day, 9–5
              </button>
              <button type="button" className="ar-preset" onClick={() => preset('copyMon')}>
                Copy Monday to weekdays
              </button>
            </div>

            <div className="ar-week">
              {WEEK_ORDER.map((i) => {
                const d = form.away.schedule[i];
                if (!d) return null;
                const overnight = d.open && d.end && d.start && d.end <= d.start;
                return (
                  <div key={i} className={`ar-day ${d.open ? '' : 'closed'}`}>
                    <span className="ar-day-name">{DAY_NAMES[i].slice(0, 3)}</span>
                    <Toggle on={d.open} onChange={(v) => setDay(i, { open: v })} label={`${DAY_NAMES[i]} open`} />
                    {d.open ? (
                      <div className="ar-day-times">
                        <input className="input tnum" type="time" step={300} value={d.start} onChange={(e) => setDay(i, { start: e.target.value })} aria-label={`${DAY_NAMES[i]} opens`} />
                        <span className="ar-to">to</span>
                        <input className="input tnum" type="time" step={300} value={d.end === '24:00' ? '23:59' : d.end} onChange={(e) => setDay(i, { end: e.target.value })} aria-label={`${DAY_NAMES[i]} closes`} />
                        {overnight && <span className="ar-overnight">next day</span>}
                      </div>
                    ) : (
                      <span className="ar-day-closed">Closed all day</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="ar-away-col">
            <div className="ar-col-h">Away reply</div>
            <ReplySource
              mode={form.away.mode}
              onMode={(v) => setAway('mode', v)}
              text={form.away.message}
              onText={(v) => setAway('message', v)}
              templateId={form.away.templateId}
              onTemplate={(v) => setAway('templateId', v)}
              templates={templates}
              businessName={businessName}
              timezone={effTz}
              placeholder="Thanks for messaging {{business_name}}! We’re closed right now — we’ll reply first thing when we open."
              onGoTemplates={onGoTemplates}
            />
            <div className="ar-two">
              <Field label="Don’t repeat for" hint="Per contact, so a chatty customer gets one away reply, not ten.">
                <div className="ar-suffix">
                  <input
                    className="input tnum"
                    type="number"
                    min={0}
                    max={720}
                    value={form.away.cooldownHours}
                    onChange={(e) => setAway('cooldownHours', e.target.value === '' ? '' : Math.max(0, Math.min(720, Number(e.target.value))))}
                  />
                  <span>hours</span>
                </div>
              </Field>
            </div>
            <Field label="On these numbers">
              <NumberScope numbers={numbers} value={form.away.sessionIds} onChange={(v) => setAway('sessionIds', v)} />
            </Field>
            <div className="ar-inline-note">
              <Icon name="info" size={14} />
              <span>Keyword rules go first — if a rule already replied, the away message stays quiet.</span>
            </div>
          </div>
        </div>
      </div>

      <div className={`card ar-away ${form.welcome.enabled ? '' : 'is-off'}`}>
        <div className="card-head">
          <div className="row" style={{ gap: 12 }}>
            <div className="ar-head-ic welcome">
              <Icon name="star" size={17} />
            </div>
            <div>
              <h3>Welcome message</h3>
              <div className="ar-sub">Sent once to brand-new contacts — the first time someone who isn’t in your CRM messages you.</div>
            </div>
          </div>
          <Toggle on={form.welcome.enabled} onChange={(v) => setWelcome('enabled', v)} label="Welcome message enabled" />
        </div>
        <div className="ar-away-grid">
          <div className="ar-away-col">
            <ReplySource
              mode={form.welcome.mode}
              onMode={(v) => setWelcome('mode', v)}
              text={form.welcome.message}
              onText={(v) => setWelcome('message', v)}
              templateId={form.welcome.templateId}
              onTemplate={(v) => setWelcome('templateId', v)}
              templates={templates}
              businessName={businessName}
              placeholder="Hi {{first_name|there}} 👋 Welcome to {{business_name}}! How can we help?"
              onGoTemplates={onGoTemplates}
            />
          </div>
          <div className="ar-away-col">
            <Field label="On these numbers">
              <NumberScope numbers={numbers} value={form.welcome.sessionIds} onChange={(v) => setWelcome('sessionIds', v)} />
            </Field>
            <ul className="ar-facts">
              <li>
                <Icon name="check" size={14} />
                Each contact gets it once, ever.
              </li>
              <li>
                <Icon name="check" size={14} />
                Existing CRM contacts never receive it.
              </li>
              <li>
                <Icon name="check" size={14} />
                Can go out alongside a keyword reply or the away message.
              </li>
            </ul>
          </div>
        </div>
      </div>

      {dirty && (
        <div className="ar-savebar">
          <Icon name="info" size={16} />
          <span className="grow">
            Unsaved changes{awayDirty && welcomeDirty ? ' to away & welcome' : awayDirty ? ' to the away message' : ' to the welcome message'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setForm(initial);
              setErr('');
            }}
          >
            Discard
          </Button>
          <Button variant="primary" size="sm" loading={busy} onClick={save}>
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}
