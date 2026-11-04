import { useCallback, useEffect, useState } from 'react';
import { agency, loc } from '../../lib/api';
import { useLiveStatus } from '../../lib/live';
import { plural, subscriptionLabel } from '../../lib/format';
import { Avatar, Button, Drawer, Field, Pill, Skeleton, Toggle, useAction } from '../../components/ui';
import NumbersPanel from '../../components/NumbersPanel';
import ActivityFeed from '../../components/ActivityFeed';

/** Everything about one sub-account, from the agency's side. */
export default function SubAccountDrawer({ s, isAdmin, onClose, onChanged, onToggle }) {
  const act = useAction();
  const [detail, setDetail] = useState(null);
  const [cap, setCap] = useState(s.numberLimitOverride ?? '');
  const [note, setNote] = useState(s.note || '');
  const [saving, setSaving] = useState(false);
  const [feedKey, setFeedKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setDetail(await loc(s.id).overview());
    } catch {
      setDetail(null);
    }
  }, [s.id]);

  useEffect(() => {
    load();
  }, [load, s.allowed]);

  useLiveStatus((evt) => {
    if (evt.locationId === s.id && ['connected', 'disconnected', 'logged_out', 'paused', 'banned', 'replaced'].includes(evt.status)) load();
  });

  const sub = subscriptionLabel(s.subscription);
  const dirty = String(cap) !== String(s.numberLimitOverride ?? '') || note !== (s.note || '');

  const save = async () => {
    setSaving(true);
    await act(() => agency.setAccess(s.id, { numberLimit: cap === '' ? null : Number(cap), note }), 'Saved');
    setSaving(false);
    onChanged();
    load();
  };

  return (
    <Drawer
      onClose={onClose}
      header={
        <div className="row">
          <Avatar name={s.name} src={s.logoUrl} size="lg" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 750, fontSize: 16, letterSpacing: '-0.01em' }}>{s.name}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {[s.city, s.email].filter(Boolean).join(' · ') || s.id}
            </div>
          </div>
        </div>
      }
    >
      <div className="card card-pad">
        <div className="setting-row" style={{ paddingTop: 0 }}>
          <div>
            <div className="t">WhatsApp for this sub-account</div>
            <div className="d">
              {s.allowed ? 'Users here can use WhatsApp in Conversations and workflows.' : 'Numbers are paused and messages don’t sync.'}
              {s.override === null && ' Following your agency default.'}
            </div>
          </div>
          <Toggle on={s.allowed} onChange={onToggle} disabled={!isAdmin} label="Enable WhatsApp" />
        </div>
        {s.request && (
          <div className="banner warn" style={{ margin: '4px 0 8px' }}>
            <div className="grow">
              <div className="t">Access requested by {s.request.requestedBy?.name || 'a user'}</div>
              {s.request.message && <div className="d">“{s.request.message}”</div>}
            </div>
          </div>
        )}
        <div className="setting-row">
          <div>
            <div className="t">Plan</div>
            <div className="d">{s.subscription?.numberLimit ? `Includes ${plural(s.subscription.numberLimit, 'number')}` : 'Billed through the marketplace'}</div>
          </div>
          <Pill tone={sub.tone}>{sub.label}</Pill>
        </div>
        {isAdmin && (
          <div className="setting-row" style={{ alignItems: 'flex-end', gap: 12 }}>
            <Field label="Number cap" hint="Blank = plan limit / agency default">
              <input className="input tnum" type="number" min={0} style={{ width: 140 }} value={cap} onChange={(e) => setCap(e.target.value)} />
            </Field>
            <div className="grow">
              <Field label="Internal note">
                <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Rebilled at $49/mo" />
              </Field>
            </div>
            <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>
              Save
            </Button>
          </div>
        )}
      </div>

      <div>
        <div className="section-title" style={{ marginTop: 6 }}>
          Linked numbers
        </div>
        {!detail ? (
          <Skeleton h={200} r={16} />
        ) : (
          <NumbersPanel
            locationId={s.id}
            locationName={s.name}
            numbers={detail.numbers}
            limit={detail.access.numberLimit}
            canManage={isAdmin && s.allowed}
            lockedReason={!s.allowed ? 'Enable WhatsApp for this sub-account first.' : !isAdmin ? 'View only.' : null}
            isAgency
            compact
            onChanged={() => {
              load();
              onChanged();
              setFeedKey((k) => k + 1);
            }}
          />
        )}
      </div>

      <div>
        <div className="section-title" style={{ marginTop: 6 }}>
          Recent activity
        </div>
        <div className="card">
          <ActivityFeed locationId={s.id} numbers={detail?.numbers || []} limit={15} refreshKey={feedKey} />
        </div>
      </div>
    </Drawer>
  );
}
