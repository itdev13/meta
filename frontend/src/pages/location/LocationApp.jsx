import { useCallback, useEffect, useState } from 'react';
import { loc } from '../../lib/api';
import { useLiveStatus } from '../../lib/live';
import { plural } from '../../lib/format';
import { Banner, Button, Empty, Field, Pill, useAction } from '../../components/ui';
import { Icon } from '../../components/icons';
import NumbersPanel from '../../components/NumbersPanel';
import NumberSelectionPanel from '../../components/NumberSelectionPanel';
import ActivityFeed from '../../components/ActivityFeed';
import ConnectNumberModal from '../../components/ConnectNumberModal';
import AutomationsPanel from './AutomationsPanel';
import PlansPanel from './PlansPanel';
import AnalyticsPanel from './AnalyticsPanel';
import RulesPanel from './RulesPanel';
import ConsentPanel from './ConsentPanel';
import Topbar from '../../components/Topbar';

export default function LocationApp({ user }) {
  const api = loc(user.locationId);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('numbers');
  const [feedKey, setFeedKey] = useState(0);
  const [firstLink, setFirstLink] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.overview());
      setError('');
    } catch (err) {
      setError(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.locationId]);

  useEffect(() => {
    load();
  }, [load]);

  // Status changes (connected / dropped / paused) → refresh the list.
  useLiveStatus((evt) => {
    if (evt.locationId !== user.locationId) return;
    if (['connected', 'disconnected', 'logged_out', 'banned', 'replaced', 'paused'].includes(evt.status)) load();
  });

  if (error && !data) {
    return (
      <div className="center-screen">
        <Empty icon="alert" title="Couldn’t load WhatsApp" action={<Button onClick={load}>Try again</Button>}>
          {error}
        </Empty>
      </div>
    );
  }
  if (!data) return <LoadingShell />;

  const { access, numbers, stats, plans } = data;
  const sub = access.subscription;
  const connected = numbers.filter((n) => n.status === 'connected').length;
  const attention = numbers.filter((n) => ['logged_out', 'banned', 'replaced', 'disconnected'].includes(n.status)).length;

  if (!access.allowed) return <AccessBlocked user={user} access={access} onRequested={load} />;

  const managedByAgency = !access.selfConnect;
  const lockedReason = managedByAgency ? 'Your agency links numbers for this account.' : null;

  return (
    <div className="shell">
      <Topbar
        crumb="Sub-account"
        tab={tab}
        onTab={setTab}
        tabs={[
          { value: 'numbers', label: 'Numbers', icon: 'phone', count: attention || null },
          { value: 'activity', label: 'Activity', icon: 'message' },
          { value: 'analytics', label: 'Analytics', icon: 'sliders' },
          { value: 'rules', label: 'Auto-replies', icon: 'zap' },
          { value: 'consent', label: 'Consent', icon: 'shield' },
          { value: 'automations', label: 'Automations', icon: 'bolt' },
          { value: 'plan', label: 'Plan', icon: 'card' },
        ]}
        right={<SubscriptionPill sub={sub} onClick={() => setTab('plan')} />}
      />
      <main className="page">
        <SubscriptionBanner sub={sub} onPlans={() => setTab('plan')} />

        {tab === 'numbers' && (
          <>
            {numbers.length === 0 ? (
              <FirstRun canManage={!managedByAgency && sub.entitled} limit={access.numberLimit} lockedReason={lockedReason} onStart={() => setFirstLink(true)} />
            ) : (
              <>
                <div className="page-head">
                  <div>
                    <h1>WhatsApp numbers</h1>
                    <p>Every message on these numbers syncs to Conversations. Replies from the CRM go out from the number the customer last wrote to.</p>
                  </div>
                </div>
                <div className="stats">
                  <Stat k="Connected" v={connected} sub={`of ${plural(numbers.length, 'number')}`} icon="phone" />
                  <Stat k="Received · 24h" v={stats.inbound24h} icon="arrowIn" />
                  <Stat k="Sent · 24h" v={stats.outbound24h} icon="arrowOut" />
                  <Stat k="Failed · 24h" v={stats.failed24h} icon="alert" tone={stats.failed24h ? 'danger' : ''} />
                </div>
                {attention > 0 && (
                  <Banner tone="warn" icon="alert" title={`${plural(attention, 'number')} need${attention === 1 ? 's' : ''} attention`}>
                    Messages to these numbers won’t sync until they’re reconnected or linked again.
                  </Banner>
                )}
                <NumbersPanel
                  locationId={user.locationId}
                  numbers={numbers}
                  limit={access.numberLimit}
                  canManage={!managedByAgency && sub.entitled}
                  lockedReason={!sub.entitled ? 'Choose a plan to link numbers.' : lockedReason}
                  onChanged={() => {
                    load();
                    setFeedKey((k) => k + 1);
                  }}
                />
                {numbers.length >= 2 && (
                  <div className="nm-selection-mount">
                    <NumberSelectionPanel locationId={user.locationId} numbers={numbers} />
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === 'activity' && (
          <>
            <div className="page-head">
              <div>
                <h1>Activity</h1>
                <p>The latest messages across all linked numbers, with delivery status from WhatsApp.</p>
              </div>
              <Button icon="refresh" onClick={() => setFeedKey((k) => k + 1)}>
                Refresh
              </Button>
            </div>
            <div className="card">
              <ActivityFeed locationId={user.locationId} numbers={numbers} refreshKey={feedKey} />
            </div>
          </>
        )}

        {tab === 'analytics' && <AnalyticsPanel locationId={user.locationId} numbers={numbers} />}
        {tab === 'rules' && <RulesPanel locationId={user.locationId} numbers={numbers} />}
        {tab === 'consent' && <ConsentPanel locationId={user.locationId} />}
        {tab === 'automations' && <AutomationsPanel locationId={user.locationId} />}
        {tab === 'plan' && <PlansPanel sub={sub} plans={plans} access={access} />}
      </main>

      {firstLink && (
        <ConnectNumberModal
          locationId={user.locationId}
          onClose={() => {
            setFirstLink(false);
            load();
          }}
          onLinked={load}
        />
      )}
    </div>
  );
}

function Stat({ k, v, sub, icon, tone = '' }) {
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
    </div>
  );
}

export function SubscriptionPill({ sub, onClick }) {
  if (!sub?.required) return null;
  let tone = 'neutral';
  let label = 'No plan';
  if (sub.isTrial) {
    tone = 'info';
    label = `Trial · ${sub.trialDaysLeft}d left`;
  } else if (sub.status === 'active') {
    tone = 'ok';
    label = sub.plan?.name || 'Active';
  } else if (sub.status === 'past_due') {
    tone = 'err';
    label = 'Payment failed';
  }
  return (
    <button className="btn btn-ghost btn-sm" onClick={onClick} style={{ padding: 0, height: 'auto' }}>
      <Pill tone={tone} dot>
        {label}
      </Pill>
    </button>
  );
}

function SubscriptionBanner({ sub, onPlans }) {
  if (!sub?.required || sub.entitled && !(sub.isTrial && sub.trialDaysLeft <= 1)) return null;
  if (sub.isTrial) {
    return (
      <Banner tone="info" icon="info" title="Your free trial ends soon" action={<Button size="sm" onClick={onPlans}>See plans</Button>}>
        Pick a plan to keep your numbers connected after the trial.
      </Banner>
    );
  }
  const pastDue = sub.status === 'past_due';
  return (
    <Banner
      tone={pastDue ? 'err' : 'warn'}
      icon="card"
      title={pastDue ? 'Payment failed — sending is paused' : 'No active plan'}
      action={
        <Button size="sm" variant="primary" onClick={onPlans}>
          {pastDue ? 'Fix billing' : 'Choose a plan'}
        </Button>
      }
    >
      Incoming messages still sync, but replies from the CRM and workflows won’t send until a plan is active.
    </Banner>
  );
}

function FirstRun({ canManage, limit, lockedReason, onStart }) {
  return (
    <div className="hero">
      <div>
        <Pill tone="ok" dot>
          Two-way sync with Conversations
        </Pill>
        <h2 style={{ marginTop: 14 }}>Bring your WhatsApp into the CRM</h2>
        <p>
          Link the WhatsApp number you already use. Customer messages land in Conversations, your team replies from the CRM, and workflows can
          send WhatsApp messages automatically.
        </p>
        {canManage ? (
          <Button variant="primary" size="lg" icon="qr" onClick={onStart}>
            Link your first number
          </Button>
        ) : (
          <div className="row" style={{ color: 'rgba(255,255,255,.8)' }}>
            <Icon name="lock" /> {lockedReason || 'Choose a plan to link a number.'}
          </div>
        )}
        {limit > 0 && (
          <div style={{ marginTop: 14, fontSize: 12.5, color: 'rgba(255,255,255,.6)' }}>Your plan includes {plural(limit, 'number')}.</div>
        )}
      </div>
      <div className="steps">
        {[
          ['Scan a QR code', 'From WhatsApp → Linked devices, like WhatsApp Web.'],
          ['Messages sync instantly', 'New chats create or match contacts automatically.'],
          ['Reply from anywhere', 'From the CRM, the mobile app, or the phone itself.'],
        ].map(([t, d], i) => (
          <div className="step" key={t}>
            <b>{i + 1}</b>
            <div>
              <div style={{ fontWeight: 650 }}>{t}</div>
              <div style={{ fontSize: 13, opacity: 0.7 }}>{d}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AccessBlocked({ user, access, onRequested }) {
  const act = useAction();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = access.request?.status === 'pending';
  const declined = access.request?.status === 'declined';
  return (
    <div className="shell">
      <Topbar crumb="Sub-account" />
      <main className="page">
        <div className="card blocked">
          <div className="lock">
            <Icon name="lock" size={28} />
          </div>
          <h2>{pending ? 'Request sent to your agency' : 'WhatsApp isn’t enabled yet'}</h2>
          <p>
            {pending
              ? 'Your agency will review it. This page unlocks automatically once they switch WhatsApp on for this account.'
              : declined
                ? 'Your agency declined the last request. Reach out to them directly if you still need WhatsApp.'
                : 'Your agency controls which accounts can connect WhatsApp. Ask them to enable it for you.'}
          </p>
          {!pending && access.canRequestAccess && (
            <div className="stack" style={{ textAlign: 'left' }}>
              <Field label="Message to your agency (optional)">
                <textarea className="textarea" value={msg} maxLength={500} onChange={(e) => setMsg(e.target.value)} placeholder="We’d like to reply to WhatsApp leads from the CRM." />
              </Field>
              <Button
                variant="primary"
                size="lg"
                icon="send"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  await act(() => loc(user.locationId).requestAccess(msg), 'Request sent');
                  setBusy(false);
                  onRequested();
                }}
              >
                Request access
              </Button>
            </div>
          )}
          {pending && (
            <Pill tone="info" dot live>
              Pending review
            </Pill>
          )}
        </div>
      </main>
    </div>
  );
}

function LoadingShell() {
  const sk = (style) => <span className="boot-sk" style={style} />;
  return (
    <div className="shell">
      <Topbar crumb="" />
      <main className="page" aria-busy="true" aria-label="Loading WhatsApp numbers">
        <div className="page-head">
          <div style={{ width: '100%', maxWidth: 560 }}>
            {sk({ width: 240, maxWidth: '70%', height: 26 })}
            {sk({ width: '94%', height: 13, marginTop: 12 })}
          </div>
        </div>
        <div className="stats">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card stat boot-sk-card">
              <div className="row" style={{ gap: 8 }}>
                {sk({ width: 14, height: 14, borderRadius: 4 })}
                {sk({ width: '48%', height: 11 })}
              </div>
              {sk({ width: 56, height: 26, marginTop: 12 })}
            </div>
          ))}
        </div>
        <div className="numbers-grid">
          {[0, 1].map((i) => (
            <div key={i} className="card ncard boot-sk-card">
              <div className="row" style={{ gap: 12 }}>
                {sk({ width: 44, height: 44, borderRadius: 13 })}
                <div className="grow">
                  {sk({ width: '58%', height: 15 })}
                  {sk({ width: '36%', height: 11, marginTop: 8 })}
                </div>
                {sk({ width: 84, height: 24, borderRadius: 99 })}
              </div>
              {sk({ height: 62, borderRadius: 10 })}
              <div className="row" style={{ gap: 8 }}>
                {sk({ width: 96, height: 30, borderRadius: 8 })}
                {sk({ width: 72, height: 30, borderRadius: 8 })}
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
