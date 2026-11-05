import { useCallback, useEffect, useState } from 'react';
import { loc } from '../lib/api';
import { plural } from '../lib/format';
import { Banner, Button, Modal, SectionCard, Skeleton, Toggle, useAction } from './ui';
import { Icon } from './icons';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Disconnect alerts — summary card on the Numbers tab + editor modal. */
export default function AlertsPanel({ locationId }) {
  const api = loc(locationId);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.alerts());
      setError('');
    } catch (err) {
      setError(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !data) {
    return (
      <SectionCard title="Disconnect alerts" icon="bell" tone="warn">
        <div className="al-body muted">Couldn’t load alert settings: {error}</div>
      </SectionCard>
    );
  }
  if (!data) {
    return (
      <SectionCard title="Disconnect alerts" icon="bell" tone="warn">
        <div className="al-body">
          <Skeleton h={14} w="60%" />
        </div>
      </SectionCard>
    );
  }

  const { settings: s, agencyEmails, languages } = data;
  const recipients = s.emails.length + s.whatsappTo.length + (s.copyAgency ? agencyEmails : 0);
  const on = s.enabled && recipients > 0;
  const lang = languages?.find((l) => l.code === s.language)?.name || 'English';

  return (
    <>
      <SectionCard
        title="Disconnect alerts"
        sub="Get told the moment a number drops, so customer messages never go missing."
        icon="bell"
        tone={on ? 'brand' : 'warn'}
        actions={
          <>
            <span className={`al-state ${on ? 'on' : s.enabled ? 'idle' : 'off'}`}>
              <span className="al-dot" />
              {on ? 'On' : s.enabled ? 'No recipients' : 'Off'}
            </span>
            <Button size="sm" icon="settings" onClick={() => setEditing(true)}>
              {recipients ? 'Edit' : 'Set up'}
            </Button>
          </>
        }
      >
        <div className="al-body">
          {recipients === 0 ? (
            <button type="button" className="al-empty" onClick={() => setEditing(true)}>
              <span className="al-empty-ic">
                <Icon name="bell" size={18} />
              </span>
              <span>
                <b>Add who should hear about it</b>
                <span>An email or WhatsApp message when a number logs out, is restricted, or stays offline for {data.graceMinutes} minutes.</span>
              </span>
              <Icon name="chevron" size={16} />
            </button>
          ) : (
            <div className="al-summary">
              <div className="al-chips">
                {s.emails.map((e) => (
                  <span key={e} className="al-chip">
                    <Icon name="mail" size={13} />
                    {e}
                  </span>
                ))}
                {s.whatsappTo.map((p) => (
                  <span key={p} className="al-chip wa">
                    <Icon name="message" size={13} />
                    {p}
                  </span>
                ))}
                {s.copyAgency && agencyEmails > 0 && (
                  <span className="al-chip agency">
                    <Icon name="building" size={13} />
                    Agency · {plural(agencyEmails, 'address', 'addresses')}
                  </span>
                )}
              </div>
              <div className="al-meta">
                <span>
                  <Icon name="clock" size={13} /> Logouts alert at once · drops after {data.graceMinutes} min
                </span>
                <span>{s.notifyRecovery ? 'Tells you when it’s back' : 'No “back online” message'}</span>
                <span>{lang}</span>
              </div>
            </div>
          )}
          {!data.emailReady && s.emails.length > 0 && (
            <div className="al-warn">
              <Icon name="alert" size={14} /> Email sending isn’t set up on the server yet, so only WhatsApp alerts go out.
            </div>
          )}
        </div>
      </SectionCard>
      {editing && (
        <AlertsEditor
          data={data}
          api={api}
          onClose={() => setEditing(false)}
          onSaved={(d) => {
            setData(d);
            setEditing(false);
          }}
        />
      )}
    </>
  );
}

function AlertsEditor({ data, api, onClose, onSaved }) {
  const act = useAction();
  const [s, setS] = useState(() => ({ ...data.settings }));
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(s) !== JSON.stringify(data.settings);

  const save = async () => {
    setBusy(true);
    const r = await act(() => api.saveAlerts(s), 'Alert settings saved');
    setBusy(false);
    if (r) onSaved(r);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    let r = dirty ? await act(() => api.saveAlerts(s)) : data;
    if (r) r = await act(() => api.testAlert());
    setTesting(false);
    if (r) setTestResult(r);
  };

  const sendFromNote =
    data.liveNumbers >= 2
      ? 'Sent from another of your connected numbers, never the one that dropped.'
      : 'Needs a second connected number to send from. With only one linked number, use email.';

  return (
    <Modal
      title="Disconnect alerts"
      subtitle="Who hears about it when a WhatsApp number stops syncing."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" icon="send" loading={testing} onClick={test} disabled={!s.emails.length && !s.whatsappTo.length}>
            Send a test
          </Button>
          <div className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="al-editor">
        <div className="al-switch">
          <div>
            <div className="t">Send disconnect alerts</div>
            <div className="d">
              Logouts, restrictions and takeovers alert right away. A dropped connection alerts if it’s still down after {data.graceMinutes} minutes, with a reminder every {data.reminderHours} hours (up to 3).
            </div>
          </div>
          <Toggle on={s.enabled} onChange={(v) => set('enabled', v)} label="Send disconnect alerts" />
        </div>

        <fieldset className="al-fields" disabled={!s.enabled}>
          <ListEditor
            label="Email"
            icon="mail"
            placeholder="name@company.com"
            hint="Up to 10 addresses."
            max={10}
            value={s.emails}
            onChange={(v) => set('emails', v)}
            normalize={(v) => v.trim().toLowerCase()}
            validate={(v) => (EMAIL_RE.test(v) ? '' : 'That doesn’t look like an email address.')}
          />
          {!data.emailReady && (
            <Banner tone="warn" icon="alert" title="Email isn’t set up on the server yet">
              Addresses are saved, but nothing is emailed until the server’s email settings are added.
            </Banner>
          )}

          <ListEditor
            label="WhatsApp"
            icon="message"
            placeholder="+1 512 555 0142"
            hint={sendFromNote}
            max={5}
            value={s.whatsappTo}
            onChange={(v) => set('whatsappTo', v)}
            normalize={(v) => {
              const d = v.replace(/[^\d]/g, '');
              return d ? `+${d}` : '';
            }}
            validate={(v) => (v.length >= 9 && v.length <= 16 ? '' : 'Use the full number with country code.')}
          />

          <div className="al-group">
            <div className="al-label">Language</div>
            <div className="al-langs" role="radiogroup" aria-label="Alert language">
              {(data.languages || []).map((l) => (
                <button
                  key={l.code}
                  type="button"
                  role="radio"
                  aria-checked={s.language === l.code}
                  className={`al-lang ${s.language === l.code ? 'on' : ''}`}
                  onClick={() => set('language', l.code)}
                >
                  {l.name}
                </button>
              ))}
            </div>
          </div>

          <div className="al-rows">
            <div className="setting-row">
              <div>
                <div className="t">Tell me when it’s back</div>
                <div className="d">A short “back online” message once the number reconnects.</div>
              </div>
              <Toggle on={s.notifyRecovery} onChange={(v) => set('notifyRecovery', v)} label="Tell me when it’s back" />
            </div>
            {data.agencyEmails > 0 && (
              <div className="setting-row">
                <div>
                  <div className="t">Copy the agency</div>
                  <div className="d">Your agency also gets these alerts ({plural(data.agencyEmails, 'address', 'addresses')}).</div>
                </div>
                <Toggle on={s.copyAgency} onChange={(v) => set('copyAgency', v)} label="Copy the agency" />
              </div>
            )}
          </div>
        </fieldset>

        {testResult && (
          <Banner tone={testResult.email || testResult.whatsapp ? 'ok' : 'warn'} icon={testResult.email || testResult.whatsapp ? 'check' : 'alert'} title="Test sent">
            {[testResult.email ? `${plural(testResult.email, 'email')}` : '', testResult.whatsapp ? `${plural(testResult.whatsapp, 'WhatsApp message')}` : ''].filter(Boolean).join(' and ') || 'Nothing went out.'}
            {testResult.why ? ` ${testResult.why}` : ''}
          </Banner>
        )}
      </div>
    </Modal>
  );
}

export function ListEditor({ label, icon, placeholder, hint, max, value, onChange, normalize, validate }) {
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');
  const add = () => {
    const v = normalize(draft);
    if (!v) return;
    const problem = validate(v);
    if (problem) return setErr(problem);
    if (value.includes(v)) return setDraft('');
    if (value.length >= max) return setErr(`Up to ${max}.`);
    onChange([...value, v]);
    setDraft('');
    setErr('');
    return undefined;
  };
  return (
    <div className="al-group">
      <div className="al-label">
        <Icon name={icon} size={14} /> {label}
        <span>
          {value.length}/{max}
        </span>
      </div>
      <div className={`al-list ${err ? 'bad' : ''}`}>
        {value.map((v) => (
          <span key={v} className="al-chip">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          placeholder={value.length ? 'Add another…' : placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            setErr('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              if (draft.trim()) {
                e.preventDefault();
                add();
              }
            } else if (e.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={add}
        />
      </div>
      <div className={`al-hint ${err ? 'err' : ''}`}>{err || hint}</div>
    </div>
  );
}
