const WaSession = require('../../schemas/wa-session.schema');
const MessageLog = require('../../schemas/message-log.schema');
const { ghlSignatureGuard } = require('../../webhooks/ghl-signature');
const { TRIGGERS } = require('../../workflows/trigger-keys');
const { normalizeJid, isPnJid, isLidJid, jidToPhone, digits } = require('../../whatsapp/jid');

/**
 * Feature: WhatsApp Voice — call history in the CRM.
 *
 * A QR-linked device receives call *signalling* (offer → ringing → accept/reject/timeout →
 * terminate) but cannot carry audio. So this feature:
 *   • logs every 1:1 WhatsApp call to the contact's conversation under the Call-type provider
 *     (GHL_CALL_PROVIDER_ID): answered on the phone / declined / missed
 *   • optionally auto-declines calls (chat-only businesses)
 *   • optionally sends a missed-call WhatsApp reply (with a per-contact cooldown)
 *   • fires the whatsapp_call_received workflow trigger
 *   • answers the Call provider's Delivery URL: placing calls from the CRM isn't possible on a
 *     linked device, so the attempt is marked failed with a clear reason.
 *
 * Per-number settings: callLogging, autoRejectCalls, missedCallReply, missedCallMessage.
 */
const FINALIZE_DELAY_MS = 1500;       // collect accept/reject before deciding the outcome
const STATE_TTL_MS = 2 * 60 * 60 * 1000;
const REPLY_COOLDOWN_MS = 30 * 60 * 1000;

const GHL_STATUS = { answered: 'completed', declined: 'busy', missed: 'no-answer' };
const LABEL = { answered: 'Answered on phone', declined: 'Declined', missed: 'Missed' };

function register({ app, services }) {
  const { sessionManager, contactService, ghlService, messagingService, workflowsService } = services;
  const callProviderId = () => process.env.GHL_CALL_PROVIDER_ID || '';

  const calls = new Map();       // `${sessionId}:${callId}` → state
  const lastReply = new Map();   // `${locationId}:${contactId}` → ms
  const sessionCache = new Map(); // sessionId → { doc, at }

  sessionManager.on('session.settings', ({ sessionId }) => sessionCache.delete(String(sessionId)));

  async function sessionDoc(id) {
    const hit = sessionCache.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.doc;
    const doc = await WaSession.findById(id).lean();
    sessionCache.set(id, { doc, at: Date.now() });
    return doc;
  }

  // Housekeeping: drop call states that never terminated.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, st] of calls) if (st.startedAt < cutoff) calls.delete(k);
    for (const [k, at] of lastReply) if (at < Date.now() - REPLY_COOLDOWN_MS) lastReply.delete(k);
  }, 10 * 60 * 1000);
  sweep.unref?.();

  sessionManager.on('call', ({ session, sock, calls: events }) => {
    for (const evt of events || []) {
      onCallEvent(session, sock, evt).catch((err) => console.warn(`[Calls] ${session.id} ${evt?.id}: ${err.message}`));
    }
  });

  async function onCallEvent(session, sock, evt) {
    if (!evt?.id || evt.isGroup) return; // group calls aren't logged
    const key = `${session.id}:${evt.id}`;
    let st = calls.get(key);

    if (!st) {
      // Register the call synchronously so events arriving back-to-back (offer, accept,
      // terminate in one tick) all share ONE state; async setup runs once via st.ready.
      st = {
        session,
        doc: null,
        from: normalizeJid(evt.from || evt.chatId),
        isVideo: !!evt.isVideo,
        offline: !!evt.offline,
        startedAt: evt.date ? new Date(evt.date).getTime() : Date.now(),
        accepted: false,
        rejected: false,
        rejectedByUs: false,
        timer: null,
        done: false,
      };
      calls.set(key, st);
      const firstStatus = evt.status;
      st.ready = (async () => {
        const doc = await sessionDoc(session.id);
        if (!doc || !doc.isActive) {
          st.done = true;
          return;
        }
        st.doc = doc;
        const s = doc.settings || {};
        // Respect inbound controls before doing anything visible.
        const phone = jidToPhone(st.from);
        const blacklisted = phone && (s.blacklist || []).some((b) => digits(b) === digits(phone));
        if (s.disableIncoming || blacklisted) {
          st.done = true; // later events for this call are ignored
          return;
        }
        if (s.autoRejectCalls && (firstStatus === 'offer' || firstStatus === 'ringing') && !st.offline) {
          st.rejectedByUs = true;
          try {
            await sock.rejectCall(evt.id, evt.from);
          } catch (err) {
            console.warn(`[Calls] auto-decline failed ${session.id}: ${err.message}`);
          }
        }
      })();
    }
    await st.ready;
    if (st.done) return;

    if (evt.status === 'accept') st.accepted = true;
    if (evt.status === 'reject') st.rejected = true;
    if (['terminate', 'timeout', 'reject'].includes(evt.status) || st.rejectedByUs) {
      if (!st.timer) st.timer = setTimeout(() => finalize(key).catch((err) => console.warn(`[Calls] finalize ${key}: ${err.message}`)), FINALIZE_DELAY_MS);
    }
  }

  async function finalize(key) {
    const st = calls.get(key);
    calls.delete(key);
    if (!st || st.done) return;
    st.done = true;

    const { session, doc } = st;
    const s = doc.settings || {};
    const outcome = st.accepted ? 'answered' : st.rejected || st.rejectedByUs ? 'declined' : 'missed';
    const callId = key.split(':').slice(1).join(':');
    const pnJid = isPnJid(st.from) ? st.from : null;
    const lidJid = isLidJid(st.from) ? st.from : null;
    const phone = jidToPhone(pnJid);
    const kind = st.isVideo ? 'video call' : 'call';

    // Dedupe (WhatsApp can redeliver call events after a reconnect).
    try {
      await MessageLog.create({
        locationId: session.locationId,
        companyId: session.companyId,
        sessionId: session.id,
        direction: 'inbound',
        source: 'contact',
        waJid: st.from,
        waMessageId: `call:${callId}`,
        kind: 'call',
        preview: `${LABEL[outcome]} WhatsApp ${kind}`,
        status: 'delivered',
      });
    } catch (err) {
      if (err.code === 11000) return;
      throw err;
    }

    // Contact: never create one when the number is set to "don't create contacts".
    const resolved = s.doNotCreateContacts
      ? await contactService.findExisting({ locationId: session.locationId, sessionId: session.id, pnJid, lidJid, pushName: '' })
      : await contactService.resolveInbound({ locationId: session.locationId, sessionId: session.id, linkedNumber: doc.phoneNumber, pnJid, lidJid, pushName: '' });
    const contactId = resolved?.mapping?.ghlContactId;
    if (!contactId) return;
    await MessageLog.updateOne({ sessionId: session.id, waMessageId: `call:${callId}` }, { $set: { ghlContactId: contactId } });

    const text = `📞 ${LABEL[outcome]} WhatsApp ${kind}${outcome === 'missed' && st.offline ? ' (while offline)' : ''}`;
    if (s.callLogging !== false) await logToGhl({ session, doc, contactId, phone, callId, outcome, text, at: st.startedAt });

    const payload = {
      contactId,
      locationId: session.locationId,
      phone: phone || '',
      callStatus: outcome,
      isVideo: st.isVideo,
      linkedNumber: doc.phoneNumber || '',
      linkedNumberLabel: doc.label || '',
      timestamp: new Date(st.startedAt).toISOString(),
    };
    workflowsService.fireTrigger(TRIGGERS.CALL_RECEIVED, session.locationId, payload).catch(() => {});

    // Missed/declined → optional WhatsApp reply from the same number (consent still applies).
    const message = String(s.missedCallMessage || '').trim();
    if (outcome !== 'answered' && s.missedCallReply && message) {
      const rk = `${session.locationId}:${contactId}`;
      if (Date.now() - (lastReply.get(rk) || 0) > REPLY_COOLDOWN_MS) {
        lastReply.set(rk, Date.now());
        messagingService
          .send({ locationId: session.locationId, contactId, text: message, source: 'auto', mirror: true, preferredSessionId: session.id, meta: { feature: 'calls' } })
          .catch((err) => console.warn(`[Calls] missed-call reply not sent (${session.locationId}): ${err.message}`));
      }
    }
  }

  /** Call record under the Call provider; falls back to a text line so the call is never lost. */
  async function logToGhl({ session, doc, contactId, phone, callId, outcome, text, at }) {
    const providerId = callProviderId();
    if (providerId) {
      try {
        await ghlService.addInboundMessage(session.locationId, {
          type: 'Call',
          conversationProviderId: providerId,
          contactId,
          direction: 'inbound',
          altId: `call:${callId}`,
          date: new Date(at).toISOString(),
          call: { to: doc.phoneNumber || '', from: phone || '', status: GHL_STATUS[outcome] },
        });
        return;
      } catch (err) {
        console.warn(`[Calls] Call-type log rejected by GHL (${err?.response?.status || err.message}) — falling back to a text entry`);
      }
    }
    try {
      await ghlService.addInboundMessage(session.locationId, {
        conversationProviderId: process.env.GHL_CONVERSATION_PROVIDER_ID,
        contactId,
        message: text,
        altId: `call:${callId}`,
        date: new Date(at).toISOString(),
      });
    } catch (err) {
      console.warn(`[Calls] could not log call for ${session.locationId}: ${err.message}`);
    }
  }

  // ── Call provider Delivery URL ────────────────────────────────
  // GHL posts here when someone clicks "call" on a WhatsApp Voice conversation. A linked device
  // can't place calls, so acknowledge and mark the attempt failed with an actionable reason.
  const mw = [ghlSignatureGuard]; // /webhooks/* is already rate-limited in main.js
  app.post('/webhooks/ghl-call', ...mw, async (req, res) => {
    res.json({ ok: true });
    const { locationId, messageId } = req.body || {};
    if (!locationId || !messageId) return;
    await ghlService.updateMessageStatus(locationId, messageId, 'failed', {
      code: 'calls_not_supported',
      type: 'saas',
      message: 'WhatsApp calls can’t be placed from the CRM. Call from the WhatsApp app on the linked phone, or send a WhatsApp message instead.',
    });
  });
}

module.exports = { register };
