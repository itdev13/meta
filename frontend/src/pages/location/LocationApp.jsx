import { useCallback, useEffect, useState } from 'react';
import { loc } from '../../lib/api';
import { useLiveStatus } from '../../lib/live';
import { plural } from '../../lib/format';
import { Banner, Button, EmptyState, Field, KpiGrid, KpiSkeleton, KpiTile, PageHeader, Pill, SyncMeta, useAction } from '../../components/ui';
import { Icon } from '../../components/icons';
import NumbersPanel from '../../components/NumbersPanel';
import NumberSelectionPanel from '../../components/NumberSelectionPanel';
import AlertsPanel from '../../components/AlertsPanel';
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
  const [loadedAt, setLoadedAt] = useState(null);
  const [reloading, setReloading] = useState(false);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await api.overview());
      setError('');
      setLoadedAt(new Date());
    } catch (err) {
      setError(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.locationId]);

  useEffect(() => {
    load();
  }, [load]);

  // Keep "Updated 2m ago" honest without a reload.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  // Status changes (connected / dropped / paused) → refresh the list.
  useLiveStatus((evt) => {
    if (evt.locationId !== user.locationId) return;
    if (['connected', 'disconnected', 'logged_out', 'banned', 'replaced', 'paused'].includes(evt.status)) load();
  });

  if (error && !data) {
    return (
      <div className="center-screen lc">
        <div className="lc-fatal">
          <EmptyState icon="alert" tone="err" title="Couldn’t load WhatsApp" action={<Button icon="refresh" onClick={load}>Try again</Button>}>
            {error}
          </EmptyState>
        </div>
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

  const reload = async () => {
    setReloading(true);
    await load();
    setReloading(false);
  };

  return (
    <div className="shell lc">
      <Topbar
        crumb="Sub-account"
        tab={tab}
        onTab={setTab}
        tabs={[
          { value: 'numbers', label: 'Numbers', icon: 'phone', count: attention || null },
          { value: 'activity', label: 'Activity', icon: 'message' },
          { value: 'analytics', label: 'Analytics', icon: 'chart' },
          { value: 'rules', label: 'Auto-replies', icon: 'zap' },
          { value: 'consent', label: 'Consent', icon: 'shield' },
          { value: 'automations', label: 'Automations', icon: 'flow' },
          { value: 'plan', label: 'Plan', icon: 'card' },
        ]}
        right={<SubscriptionPill sub={sub} onClick={() => setTab('plan')} />}
      />
      <main className="page lc-main">
        <SubscriptionBanner sub={sub} onPlans={() => setTab('plan')} />

        <div className="lc-page" key={tab}>
          {tab === 'numbers' &&
            (numbers.length === 0 ? (
              <FirstRun canManage={!managedByAgency && sub.entitled} limit={access.numberLimit} lockedReason={lockedReason} onStart={() => setFirstLink(true)} />
            ) : (
              <>
                <PageHeader
                  eyebrow="WhatsApp"
                  title="Your numbers"
                  description="Every message on these numbers syncs to Conversations. Replies from the CRM go out from the number the customer last wrote to."
                  actions={<SyncMeta at={loadedAt} loading={reloading} onRefresh={reload} />}
                />
                <KpiGrid cols={4}>
                  <KpiTile
                    label="Connected"
                    icon="phone"
                    tone="brand"
                    value={connected}
                    unit={`/ ${numbers.length}`}
                    meter={numbers.length ? connected / numbers.length : 0}
                    hint={connected === numbers.length ? 'Every number is online' : `${plural(numbers.length - connected, 'number')} offline`}
                  />
                  <KpiTile label="Received · 24h" icon="arrowIn" tone="info" value={stats.inbound24h.toLocaleString()} hint="Customer messages synced to the CRM" />
                  <KpiTile label="Sent · 24h" icon="arrowOut" tone="teal" value={stats.outbound24h.toLocaleString()} hint="From the CRM, workflows and the phone" />
                  <KpiTile
                    label="Failed · 24h"
                    icon="alert"
                    tone={stats.failed24h ? 'alert' : 'calm'}
                    value={stats.failed24h.toLocaleString()}
                    hint={stats.failed24h ? 'See Activity for the reasons' : 'Every message went through'}
                    onClick={stats.failed24h ? () => setTab('activity') : null}
                  />
                </KpiGrid>
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
                <div className="al-mount">
                  <AlertsPanel locationId={user.locationId} />
                </div>
                {numbers.length >= 2 && (
                  <div className="nm-selection-mount">
                    <NumberSelectionPanel locationId={user.locationId} numbers={numbers} />
                  </div>
                )}
              </>
            ))}

          {tab === 'activity' && (
            <>
              <PageHeader
                eyebrow="Live feed"
                title="Activity"
                description="The latest messages across all linked numbers, with delivery status from WhatsApp."
                actions={
                  <Button icon="refresh" onClick={() => setFeedKey((k) => k + 1)}>
                    Refresh
                  </Button>
                }
              />
              <section className="card lc-card flush lc-feed-card">
                <header className="lc-card-head">
                  <span className="lc-card-ic tone-brand">
                    <Icon name="message" size={15} />
                  </span>
                  <div className="lc-card-title">
                    <h3>Latest messages</h3>
                    <p>{numbers.length ? `Across ${plural(numbers.length, 'linked number')}` : 'No numbers linked yet'}</p>
                  </div>
                  <ul className="lc-feed-legend" aria-label="Legend">
                    <li>
                      <span className="lc-dir-dot in" />
                      Received
                    </li>
                    <li>
                      <span className="lc-dir-dot out" />
                      Sent
                    </li>
                    <li>
                      <span className="lc-dir-dot fail" />
                      Failed
                    </li>
                  </ul>
                </header>
                <ActivityFeed locationId={user.locationId} numbers={numbers} refreshKey={feedKey} />
              </section>
            </>
          )}

          {tab === 'analytics' && <AnalyticsPanel locationId={user.locationId} numbers={numbers} onGoNumbers={() => setTab('numbers')} />}
          {tab === 'rules' && <RulesPanel locationId={user.locationId} numbers={numbers} />}
          {tab === 'consent' && <ConsentPanel locationId={user.locationId} />}
          {tab === 'automations' && <AutomationsPanel locationId={user.locationId} />}
          {tab === 'plan' && <PlansPanel sub={sub} plans={plans} access={access} />}
        </div>
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
    <button className="btn btn-ghost btn-sm lc-subpill" onClick={onClick} style={{ padding: 0, height: 'auto' }} title="View plan">
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

const FIRST_RUN_STEPS = [
  ['qr', 'Scan a QR code', 'From WhatsApp → Linked devices, just like WhatsApp Web.'],
  ['refresh', 'Messages sync instantly', 'New chats create or match contacts automatically.'],
  ['send', 'Reply from anywhere', 'From the CRM, the mobile app, or the phone itself.'],
];

function FirstRun({ canManage, limit, lockedReason, onStart }) {
  return (
    <div className="hero lc-hero">
      <div className="lc-hero-copy">
        <span className="lc-hero-chip">
          <span className="lc-hero-chip-dot" />
          Two-way sync with Conversations
        </span>
        <h2>Bring your WhatsApp into the CRM</h2>
        <p>
          Link the WhatsApp number you already use. Customer messages land in Conversations, your team replies from the CRM, and workflows can
          send WhatsApp messages automatically.
        </p>
        {canManage ? (
          <div className="lc-hero-cta">
            <Button variant="primary" size="lg" icon="qr" onClick={onStart}>
              Link your first number
            </Button>
            <span className="lc-hero-time">
              <Icon name="clock" size={14} />
              Takes under a minute
            </span>
          </div>
        ) : (
          <div className="lc-hero-locked">
            <Icon name="lock" size={15} /> {lockedReason || 'Choose a plan to link a number.'}
          </div>
        )}
        {limit > 0 && <div className="lc-hero-limit">Your plan includes {plural(limit, 'number')}.</div>}
      </div>
      <div className="lc-hero-side">
        <ol className="lc-hero-steps">
          {FIRST_RUN_STEPS.map(([icon, t, d], i) => (
            <li className="lc-hero-step" key={t}>
              <span className="lc-hero-step-ic">
                <Icon name={icon} size={16} />
              </span>
              <div className="grow">
                <div className="lc-hero-step-t">
                  <span className="lc-hero-step-n">{i + 1}</span>
                  {t}
                </div>
                <div className="lc-hero-step-d">{d}</div>
              </div>
            </li>
          ))}
        </ol>
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
  const stage = pending ? 1 : 0;
  const steps = [
    ['send', 'Request access', pending ? 'Sent' : 'From this page'],
    ['building', 'Agency reviews', pending ? 'In review' : 'Usually quick'],
    ['check', 'WhatsApp unlocks', 'Automatically'],
  ];
  return (
    <div className="shell lc">
      <Topbar crumb="Sub-account" />
      <main className="page lc-main">
        <div className="lc-blocked lc-page">
          <div className="card lc-blocked-card">
            <div className={`lc-blocked-art ${pending ? 'pending' : declined ? 'declined' : ''}`} aria-hidden="true">
              <span className="lc-blocked-ring" />
              <span className="lc-blocked-ic">
                <Icon name={pending ? 'clock' : 'lock'} size={26} />
              </span>
            </div>
            <div className="lc-blocked-tag">
              {pending ? (
                <Pill tone="info" dot live>
                  Pending review
                </Pill>
              ) : declined ? (
                <Pill tone="err" dot>
                  Last request declined
                </Pill>
              ) : (
                <Pill tone="neutral" dot>
                  Access needed
                </Pill>
              )}
            </div>
            <h2>{pending ? 'Request sent to your agency' : 'WhatsApp isn’t enabled yet'}</h2>
            <p>
              {pending
                ? 'Your agency will review it. This page unlocks automatically once they switch WhatsApp on for this account.'
                : declined
                  ? 'Your agency declined the last request. Reach out to them directly if you still need WhatsApp.'
                  : 'Your agency controls which accounts can connect WhatsApp. Ask them to enable it for you.'}
            </p>

            <ol className="lc-progress" aria-label="How access works">
              {steps.map(([icon, t, d], i) => (
                <li key={t} className={i < stage ? 'done' : i === stage ? 'current' : ''}>
                  <span className="lc-progress-ic">
                    <Icon name={i < stage ? 'check' : icon} size={14} />
                  </span>
                  <span className="lc-progress-t">{t}</span>
                  <span className="lc-progress-d">{d}</span>
                </li>
              ))}
            </ol>

            {!pending && access.canRequestAccess && (
              <div className="lc-blocked-form">
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
          </div>

          <ul className="lc-blocked-perks">
            {[
              ['message', 'Two-way sync', 'WhatsApp chats in Conversations'],
              ['flow', 'Workflows', 'Triggers and send actions'],
              ['zap', 'Auto-replies', 'Keywords, away and welcome'],
            ].map(([icon, t, d]) => (
              <li key={t}>
                <span className="lc-blocked-perk-ic">
                  <Icon name={icon} size={15} />
                </span>
                <div>
                  <b>{t}</b>
                  <span>{d}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}

function LoadingShell() {
  const sk = (style) => <span className="boot-sk" style={style} />;
  return (
    <div className="shell lc">
      <Topbar crumb="" />
      <main className="page lc-main" aria-busy="true" aria-label="Loading WhatsApp numbers">
        <div className="lc-head">
          <div className="lc-head-text" style={{ width: '100%', maxWidth: 560 }}>
            {sk({ width: 70, height: 10 })}
            {sk({ width: 240, maxWidth: '70%', height: 26, marginTop: 10 })}
            {sk({ width: '94%', height: 13, marginTop: 12 })}
          </div>
        </div>
        <KpiSkeleton count={4} />
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

