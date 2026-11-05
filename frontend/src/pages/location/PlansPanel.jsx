import { Banner, Button, PageHeader, Pill } from '../../components/ui';
import { Icon } from '../../components/icons';
import { plural } from '../../lib/format';

const PERKS = ['Two-way sync with Conversations', 'Workflow triggers & actions', 'Media, voice notes & documents', 'Replies from phone mirrored to CRM'];

function currentSummary(sub, access) {
  if (!sub?.required) return { tone: 'ok', icon: 'check', t: 'WhatsApp is included', d: 'No plan is needed for this account.' };
  if (sub.isTrial) return { tone: 'info', icon: 'clock', t: `Free trial · ${plural(sub.trialDaysLeft, 'day')} left`, d: 'Pick a plan below to keep your numbers connected after the trial.' };
  if (sub.status === 'active') return { tone: 'ok', icon: 'check', t: `${sub.plan?.name || 'Active'} plan`, d: `Up to ${plural(access.numberLimit ?? access.planNumberLimit ?? 0, 'number')} on this account.` };
  if (sub.status === 'past_due') return { tone: 'err', icon: 'alert', t: 'Payment failed', d: 'Sending is paused until billing is fixed in your CRM.' };
  return { tone: 'warn', icon: 'card', t: 'No active plan', d: 'Incoming messages still sync. Choose a plan to send from the CRM and workflows.' };
}

export default function PlansPanel({ sub, plans, access }) {
  const open = (url) => url && window.open(url, '_blank', 'noopener');
  const agencyCapped = access.agencyNumberLimit != null && access.agencyNumberLimit < access.planNumberLimit;
  const cur = currentSummary(sub, access);
  return (
    <>
      <PageHeader
        eyebrow="Billing"
        title="Plan"
        description="Billing runs through your CRM’s marketplace — changes apply instantly."
        actions={
          sub?.isTrial ? (
            <Pill tone="info" dot>
              Free trial · {sub.trialDaysLeft}d left
            </Pill>
          ) : null
        }
      />

      <div className={`lc-current tone-${cur.tone}`}>
        <span className="lc-current-ic">
          <Icon name={cur.icon} size={18} />
        </span>
        <div className="grow">
          <div className="lc-current-k">Current status</div>
          <div className="lc-current-t">{cur.t}</div>
          <div className="lc-current-d">{cur.d}</div>
        </div>
        <div className="lc-current-meta">
          <Icon name="lock" size={13} />
          Billed securely via the marketplace
        </div>
      </div>

      {agencyCapped && (
        <Banner tone="info" icon="building" title={`Your agency allows up to ${plural(access.agencyNumberLimit, 'number')}`}>
          Upgrading your plan won’t raise this — ask your agency if you need more.
        </Banner>
      )}
      <div className="plans lc-plans">
        {plans.map((p) => {
          const current = p.isCurrent && sub?.entitled;
          return (
            <div key={p.planId || p.name} className={`card plan lc-plan ${current ? 'current' : ''}`}>
              {current && (
                <span className="lc-plan-flag">
                  <Icon name="check" size={12} stroke={3} />
                  Current plan
                </span>
              )}
              <div className="lc-plan-name">{p.name}</div>
              <div className="price">
                ${p.priceUsd}
                <small> / month</small>
              </div>
              <div className="lc-plan-limit">
                <Icon name="phone" size={14} />
                {plural(p.numberLimit, 'WhatsApp number')}
              </div>
              <ul>
                {PERKS.map((x) => (
                  <li key={x}>
                    <Icon name="check" size={15} />
                    {x}
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 'auto' }}>
                {current ? (
                  <Button className="grow" style={{ width: '100%' }} disabled>
                    Your plan
                  </Button>
                ) : (
                  <Button variant="primary" style={{ width: '100%' }} icon="external" onClick={() => open(p.url)} disabled={!p.url}>
                    {sub?.status === 'active' ? 'Switch plan' : 'Choose plan'}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
