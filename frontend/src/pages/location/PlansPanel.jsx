import { Banner, Button, Pill } from '../../components/ui';
import { Icon } from '../../components/icons';
import { plural } from '../../lib/format';

const PERKS = ['Two-way sync with Conversations', 'Workflow triggers & actions', 'Media, voice notes & documents', 'Replies from phone mirrored to CRM'];

export default function PlansPanel({ sub, plans, access }) {
  const open = (url) => url && window.open(url, '_blank', 'noopener');
  const agencyCapped = access.agencyNumberLimit != null && access.agencyNumberLimit < access.planNumberLimit;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Plan</h1>
          <p>Billing runs through your CRM’s marketplace — changes apply instantly.</p>
        </div>
        {sub?.isTrial && (
          <Pill tone="info" dot>
            Free trial · {sub.trialDaysLeft}d left
          </Pill>
        )}
      </div>
      {agencyCapped && (
        <Banner tone="info" icon="building" title={`Your agency allows up to ${plural(access.agencyNumberLimit, 'number')}`}>
          Upgrading your plan won’t raise this — ask your agency if you need more.
        </Banner>
      )}
      <div className="plans">
        {plans.map((p) => (
          <div key={p.planId || p.name} className={`card plan ${p.isCurrent && sub?.entitled ? 'current' : ''}`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b style={{ fontSize: 16 }}>{p.name}</b>
              {p.isCurrent && sub?.entitled && <Pill tone="ok">Current</Pill>}
            </div>
            <div className="price">
              ${p.priceUsd}
              <small> / month</small>
            </div>
            <ul>
              <li>
                <Icon name="check" size={15} />
                <b>{plural(p.numberLimit, 'WhatsApp number')}</b>
              </li>
              {PERKS.map((x) => (
                <li key={x}>
                  <Icon name="check" size={15} />
                  {x}
                </li>
              ))}
            </ul>
            <div style={{ marginTop: 'auto' }}>
              {p.isCurrent && sub?.entitled ? (
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
        ))}
      </div>
    </>
  );
}
