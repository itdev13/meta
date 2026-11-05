import { useState } from 'react';
import { agency } from '../../lib/api';
import { Banner, Button, Field, Toggle, useAction } from '../../components/ui';
import { Icon } from '../../components/icons';
import { EMAIL_RE, ListEditor } from '../../components/AlertsPanel';

export default function PolicyPanel({ settings, isAdmin, counts, onSaved }) {
  const act = useAction();
  const [s, setS] = useState({
    accessMode: settings.accessMode,
    allowSelfConnect: settings.allowSelfConnect !== false,
    allowAccessRequests: settings.allowAccessRequests !== false,
    defaultNumberLimit: settings.defaultNumberLimit ?? '',
    defaultMinDelayMs: settings.defaultMinDelayMs ?? '',
    defaultDailyLimit: settings.defaultDailyLimit ?? '',
    alertEmails: settings.alertEmails || [],
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const num = (v) => (v === '' || v === null ? null : Number(v));
  const dirty =
    s.accessMode !== settings.accessMode ||
    s.allowSelfConnect !== (settings.allowSelfConnect !== false) ||
    s.allowAccessRequests !== (settings.allowAccessRequests !== false) ||
    num(s.defaultNumberLimit) !== (settings.defaultNumberLimit ?? null) ||
    num(s.defaultMinDelayMs) !== (settings.defaultMinDelayMs ?? null) ||
    num(s.defaultDailyLimit) !== (settings.defaultDailyLimit ?? null) ||
    s.alertEmails.join('|') !== (settings.alertEmails || []).join('|');

  const save = async () => {
    setSaving(true);
    const r = await act(
      () =>
        agency.saveSettings({
          accessMode: s.accessMode,
          allowSelfConnect: s.allowSelfConnect,
          allowAccessRequests: s.allowAccessRequests,
          defaultNumberLimit: num(s.defaultNumberLimit),
          defaultMinDelayMs: num(s.defaultMinDelayMs),
          defaultDailyLimit: num(s.defaultDailyLimit),
          alertEmails: s.alertEmails,
        }),
      'Agency settings saved',
    );
    setSaving(false);
    if (r) onSaved();
  };

  const modeChangeWarning =
    s.accessMode !== settings.accessMode &&
    (s.accessMode === 'selected'
      ? `Sub-accounts you haven’t explicitly enabled will lose access. Their numbers are paused, not unlinked.`
      : `Every sub-account you haven’t explicitly disabled gets access (${counts.disabled} currently off).`);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Access & safety</h1>
          <p>Agency-wide rules. Per-sub-account switches and caps on the Sub-accounts tab override these defaults.</p>
        </div>
        {isAdmin && (
          <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>
            Save changes
          </Button>
        )}
      </div>
      {!isAdmin && (
        <Banner tone="info" icon="lock" title="View only">
          Only agency admins can change these settings.
        </Banner>
      )}

      <div className="stack" style={{ gap: 16 }}>
        <section className="card card-pad">
          <div className="section-title">Who can use WhatsApp</div>
          <div className="stack" style={{ gap: 10 }}>
            <Choice
              active={s.accessMode === 'all'}
              disabled={!isAdmin}
              onClick={() => set('accessMode', 'all')}
              title="All sub-accounts"
              desc="Every sub-account can link numbers, except ones you switch off."
            />
            <Choice
              active={s.accessMode === 'selected'}
              disabled={!isAdmin}
              onClick={() => set('accessMode', 'selected')}
              title="Only sub-accounts I choose"
              desc="WhatsApp stays locked until you enable it. Good for rebilling it as an add-on."
            />
          </div>
          {modeChangeWarning && (
            <div className="banner warn" style={{ margin: '12px 0 0' }}>
              <div className="ic">
                <Icon name="alert" size={16} />
              </div>
              <div className="d">{modeChangeWarning}</div>
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <SettingToggle
              t="Sub-accounts can link their own numbers"
              d="Off = only your agency can link or unlink numbers (you scan the QR on the client’s behalf)."
              on={s.allowSelfConnect}
              onChange={(v) => set('allowSelfConnect', v)}
              disabled={!isAdmin}
            />
            <SettingToggle
              t="Let locked sub-accounts request access"
              d="They’ll see a “Request access” button; requests show up on your Sub-accounts tab."
              on={s.allowAccessRequests}
              onChange={(v) => set('allowAccessRequests', v)}
              disabled={!isAdmin}
            />
          </div>
        </section>

        <section className="card card-pad">
          <div className="section-title">Limits</div>
          <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
            <Field label="Default number cap per sub-account" hint="Blank = whatever their plan includes.">
              <input className="input tnum" type="number" min={0} style={{ width: 200 }} value={s.defaultNumberLimit} disabled={!isAdmin} onChange={(e) => set('defaultNumberLimit', e.target.value)} placeholder="Plan limit" />
            </Field>
          </div>
        </section>

        <section className="card card-pad">
          <div className="section-title">Sending safety</div>
          <p className="muted" style={{ margin: '0 0 14px', maxWidth: 640 }}>
            WhatsApp restricts linked numbers that send too fast or too much. Every number sends one message at a time with a randomised gap and a
            daily cap. Tighter is safer.
          </p>
          <div className="row" style={{ alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
            <Field label="Minimum gap between messages (ms)" hint="Recommended 1500–3000. Blank = 1500.">
              <input className="input tnum" type="number" min={300} style={{ width: 220 }} value={s.defaultMinDelayMs} disabled={!isAdmin} onChange={(e) => set('defaultMinDelayMs', e.target.value)} placeholder="1500" />
            </Field>
            <Field label="Daily messages per number" hint="Resets at 00:00 UTC. Blank = 1000.">
              <input className="input tnum" type="number" min={1} style={{ width: 220 }} value={s.defaultDailyLimit} disabled={!isAdmin} onChange={(e) => set('defaultDailyLimit', e.target.value)} placeholder="1000" />
            </Field>
          </div>
        </section>

        <section className="card card-pad">
          <div className="section-title">Disconnect alerts</div>
          <p className="muted" style={{ margin: '0 0 14px', maxWidth: 640 }}>
            These addresses get an email whenever a number in any sub-account logs out, is restricted, or stays offline. Each sub-account can add
            its own recipients on its Numbers tab, and can choose not to copy the agency.
          </p>
          <fieldset disabled={!isAdmin} style={{ border: 0, padding: 0, margin: 0, maxWidth: 560 }}>
            <ListEditor
              label="Agency alert emails"
              icon="mail"
              placeholder="ops@youragency.com"
              hint="Up to 10 addresses. Press Enter after each."
              max={10}
              value={s.alertEmails}
              onChange={(v) => set('alertEmails', v)}
              normalize={(v) => v.trim().toLowerCase()}
              validate={(v) => (EMAIL_RE.test(v) ? '' : 'That doesn’t look like an email address.')}
            />
          </fieldset>
        </section>
      </div>
    </>
  );
}

function Choice({ active, onClick, title, desc, disabled }) {
  return (
    <button type="button" className={`choice ${active ? 'active' : ''}`} onClick={onClick} disabled={disabled}>
      <span className="radio" />
      <span>
        <strong>{title}</strong>
        <span>{desc}</span>
      </span>
    </button>
  );
}

function SettingToggle({ t, d, on, onChange, disabled }) {
  return (
    <div className="setting-row">
      <div>
        <div className="t">{t}</div>
        <div className="d">{d}</div>
      </div>
      <Toggle on={on} onChange={onChange} disabled={disabled} label={t} />
    </div>
  );
}
