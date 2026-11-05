import { useEffect, useState } from 'react';
import { loc } from '../../lib/api';
import { PageHeader, Pill, SectionCard, Skeleton } from '../../components/ui';
import { plural } from '../../lib/format';
import { Icon } from '../../components/icons';

const TRIGGER_COPY = {
  whatsapp_message_received: ['Message received', 'A customer sends a WhatsApp message to any linked number.'],
  whatsapp_new_contact: ['New WhatsApp contact', 'Someone messages you on WhatsApp for the first time.'],
  whatsapp_media_received: ['Media received', 'A customer sends a photo, video, voice note or document.'],
  whatsapp_phone_reply: ['Reply sent from phone', 'Your team replies directly in the WhatsApp app.'],
  whatsapp_message_failed: ['Message failed', 'A WhatsApp message from the CRM or a workflow could not be sent.'],
  whatsapp_number_disconnected: ['Number disconnected', 'A linked number is logged out, blocked, or opened elsewhere.'],
  whatsapp_keyword_received: ['Keyword received', 'A message matches one of your keyword rules, like “C” to confirm.'],
  whatsapp_contact_opted_out: ['Contact unsubscribed', 'A contact replies STOP (or is opted out manually or by a workflow).'],
  whatsapp_contact_opted_in: ['Contact re-subscribed', 'A contact replies START, or is opted back in.'],
  whatsapp_group_message_received: ['Group message received', 'Someone writes in a WhatsApp group that’s synced to the CRM.'],
  whatsapp_call_received: ['WhatsApp call received', 'A WhatsApp call to a linked number was answered, declined or missed.'],
};
const ACTION_COPY = {
  whatsapp_send_message: ['Send WhatsApp message', 'Send text to the contact from their last-used number.'],
  whatsapp_send_media: ['Send WhatsApp media', 'Send an image, video, PDF or voice note from a URL.'],
  whatsapp_send_to_number: ['Send to any number', 'Notify a teammate or owner on WhatsApp.'],
  whatsapp_check_number: ['Check if on WhatsApp', 'Branch your workflow on whether the contact uses WhatsApp.'],
  whatsapp_send_template: ['Send WhatsApp template', 'Send a saved template with {{first_name}}-style variables filled in.'],
  whatsapp_send_to_group: ['Send to WhatsApp group', 'Post a message or file to a WhatsApp group by name or ID.'],
  whatsapp_opt_in_contact: ['Opt contact in', 'Record WhatsApp consent for the contact (logged in the consent audit trail).'],
  whatsapp_opt_out_contact: ['Opt contact out', 'Unsubscribe the contact so no WhatsApp messages are sent to them.'],
};

const HOW = [
  ['flow', 'Open Workflows', 'Automation → Workflows → create or edit a workflow.'],
  ['search', 'Search “WhatsApp”', 'When adding a trigger or an action, type WhatsApp to filter.'],
  ['bolt', 'Publish', 'Live workflows using a WhatsApp trigger are counted below.'],
];

export default function AutomationsPanel({ locationId }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    loc(locationId).automations().then(setData, () => setData({ triggers: {}, actions: {}, active: {} }));
  }, [locationId]);

  const liveTotal = data ? Object.values(data.active || {}).reduce((n, v) => n + (Number(v) || 0), 0) : 0;
  const liveTriggers = data ? Object.keys(TRIGGER_COPY).filter((k) => data.active?.[k]).length : 0;

  return (
    <>
      <PageHeader
        eyebrow="Workflows"
        title="Automations"
        description={
          <>
            Use these in <b>Automation → Workflows</b>. Search for “WhatsApp” when adding a trigger or an action.
          </>
        }
        actions={
          data ? (
            <span className={`lc-live-chip ${liveTotal ? 'on' : ''}`}>
              <span className="lc-live-dot" aria-hidden="true" />
              {liveTotal ? `${plural(liveTotal, 'live workflow')} · ${plural(liveTriggers, 'trigger')} in use` : 'No live WhatsApp workflows yet'}
            </span>
          ) : null
        }
      />

      <ol className="lc-how">
        {HOW.map(([icon, t, d], i) => (
          <li key={t}>
            <span className="lc-how-n">{i + 1}</span>
            <span className="lc-how-ic">
              <Icon name={icon} size={15} />
            </span>
            <div className="grow">
              <b>{t}</b>
              <span>{d}</span>
            </div>
          </li>
        ))}
      </ol>

      {!data ? (
        <div className="lc-auto-cols">
          {[0, 1].map((c) => (
            <section key={c} className="card lc-card">
              <header className="lc-card-head">
                <Skeleton h={30} w={30} r={9} />
                <div className="grow stack" style={{ gap: 6 }}>
                  <Skeleton h={13} w="30%" />
                  <Skeleton h={10} w="55%" />
                </div>
              </header>
              <div className="lc-auto-list">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="lc-auto-item">
                    <Skeleton h={32} w={32} r={9} />
                    <div className="grow stack" style={{ gap: 6 }}>
                      <Skeleton h={12} w="45%" />
                      <Skeleton h={10} w="80%" />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="lc-auto-cols">
          <SectionCard
            icon="zap"
            tone="violet"
            title="Triggers"
            sub="Start a workflow when something happens on WhatsApp"
            actions={<span className="lc-count">{Object.keys(TRIGGER_COPY).length}</span>}
            flush
          >
            <ul className="lc-auto-list">
              {Object.entries(TRIGGER_COPY).map(([key, [t, d]]) => (
                <li key={key} className={`lc-auto-item ${data.active?.[key] ? 'is-live' : ''}`}>
                  <span className="lc-auto-ic trigger">
                    <Icon name="zap" size={15} />
                  </span>
                  <div className="grow">
                    <div className="lc-auto-t">{t}</div>
                    <div className="lc-auto-d">{d}</div>
                  </div>
                  {data.active?.[key] ? (
                    <Pill tone="ok" dot>
                      {data.active[key]} live
                    </Pill>
                  ) : null}
                </li>
              ))}
            </ul>
          </SectionCard>
          <SectionCard
            icon="send"
            title="Actions"
            sub="Steps your workflows can take on WhatsApp"
            actions={<span className="lc-count">{Object.keys(ACTION_COPY).length}</span>}
            flush
          >
            <ul className="lc-auto-list">
              {Object.entries(ACTION_COPY).map(([key, [t, d]]) => (
                <li key={key} className="lc-auto-item">
                  <span className="lc-auto-ic action">
                    <Icon name="send" size={14} />
                  </span>
                  <div className="grow">
                    <div className="lc-auto-t">{t}</div>
                    <div className="lc-auto-d">{d}</div>
                  </div>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      )}
    </>
  );
}
