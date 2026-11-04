import { useEffect, useState } from 'react';
import { loc } from '../../lib/api';
import { Pill, Skeleton } from '../../components/ui';
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

export default function AutomationsPanel({ locationId }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    loc(locationId).automations().then(setData, () => setData({ triggers: {}, actions: {}, active: {} }));
  }, [locationId]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Automations</h1>
          <p>
            Use these in <b>Automation → Workflows</b>. Search for “WhatsApp” when adding a trigger or an action.
          </p>
        </div>
      </div>
      {!data ? (
        <div className="auto-grid">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} h={86} r={16} />
          ))}
        </div>
      ) : (
        <div className="stack" style={{ gap: 26 }}>
          <section>
            <div className="section-title">Triggers · {Object.keys(TRIGGER_COPY).length}</div>
            <div className="auto-grid">
              {Object.entries(TRIGGER_COPY).map(([key, [t, d]]) => (
                <div key={key} className="card auto">
                  <div className="ic trigger">
                    <Icon name="zap" size={17} />
                  </div>
                  <div className="grow">
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <div className="t">{t}</div>
                      {data.active?.[key] ? <Pill tone="ok">{data.active[key]} live</Pill> : null}
                    </div>
                    <div className="d">{d}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section>
            <div className="section-title">Actions · {Object.keys(ACTION_COPY).length}</div>
            <div className="auto-grid">
              {Object.entries(ACTION_COPY).map(([key, [t, d]]) => (
                <div key={key} className="card auto">
                  <div className="ic action">
                    <Icon name="send" size={16} />
                  </div>
                  <div>
                    <div className="t">{t}</div>
                    <div className="d">{d}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
