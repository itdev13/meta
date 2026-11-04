const axios = require('axios');
const WorkflowSubscription = require('../schemas/workflow-subscription.schema');
const { TRIGGERS } = require('./trigger-keys');

function isTriggerDead(payload) {
  const text = JSON.stringify(payload || '').toLowerCase();
  return /trigger with id:.*is (deleted|inactive)/.test(text) || text.includes('trigger is deleted') || text.includes('skipping execution');
}

function field(data, ...names) {
  for (const n of names) {
    const v = data?.[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/**
 * Workflow "send from" field (feature: routing). Passed through as-is; MessagingService.pickRoute
 * resolves it centrally — a session id, an index ("2", "#2", "WA#2") or a phone number. An
 * offline/unknown number falls through to the normal routing order instead of failing.
 */
function numberRef(data) {
  return field(data, 'numberId', 'fromNumber', 'sendFrom') || undefined;
}

/**
 * GHL Workflows: trigger subscriptions (GHL tells us which workflows listen to which trigger),
 * firing triggers, and executing actions.
 */
class WorkflowsService {
  constructor(authService) {
    this.auth = authService;
    this.messaging = null; // set after construction (circular: messaging ↔ workflows)
    this.manager = null;
  }

  wire({ messagingService, sessionManager }) {
    this.messaging = messagingService;
    this.manager = sessionManager;
  }

  // ── Trigger subscriptions ─────────────────────────────────────

  async handleSubscription(payload) {
    const { triggerData = {}, extras = {}, meta = {} } = payload || {};
    const { eventType, targetUrl, filters } = triggerData;
    const { locationId, workflowId, companyId } = extras;
    const triggerKey = meta.key;
    if (!workflowId || !triggerKey) return { success: false, error: 'workflowId and meta.key are required' };

    if (eventType === 'CREATED' || eventType === 'UPDATED') {
      await WorkflowSubscription.findOneAndUpdate(
        { workflowId, triggerKey },
        { locationId, companyId, workflowId, triggerKey, targetUrl, filters: filters || {}, extras, meta, status: 'active' },
        { upsert: true },
      );
    } else if (eventType === 'DELETED') {
      await WorkflowSubscription.updateOne({ workflowId, triggerKey }, { status: 'deleted' });
    }
    return { success: true };
  }

  async fireTrigger(triggerKey, locationId, eventData) {
    try {
      const subs = await WorkflowSubscription.find({ locationId, triggerKey, status: 'active' }).lean();
      if (!subs.length) return;
      let token = null;
      try {
        token = await this.auth.getAccessToken(locationId);
      } catch {
        /* fire without auth; GHL validates by target URL */
      }
      const headers = { 'Content-Type': 'application/json', Version: process.env.GHL_API_VERSION || '2021-07-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const results = await Promise.allSettled(subs.map((s) => axios.post(s.targetUrl, eventData, { headers, timeout: 10_000 })));
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const body = r.status === 'fulfilled' ? r.value?.data : r.reason?.response?.data;
        if (isTriggerDead(body) || (r.status === 'rejected' && /is deleted|is inactive|skipping execution/i.test(r.reason?.message || ''))) {
          await WorkflowSubscription.updateOne({ _id: subs[i]._id }, { status: 'deleted' });
          continue;
        }
        if (r.status === 'rejected') {
          console.warn(`[Workflows] ${triggerKey} → ${subs[i].workflowId} failed: ${r.reason?.response?.status || ''} ${JSON.stringify(body || r.reason?.message)}`);
        }
      }
    } catch (error) {
      console.error(`[Workflows] fireTrigger ${triggerKey} @ ${locationId}: ${error.message}`);
    }
  }

  async listActive(locationId) {
    const rows = await WorkflowSubscription.aggregate([
      { $match: { locationId, status: 'active' } },
      { $group: { _id: '$triggerKey', workflows: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map((r) => [r._id, r.workflows]));
  }

  // ── Actions ───────────────────────────────────────────────────
  // GHL posts { data: {…action fields}, extras: { locationId, contactId, workflowId }, meta }.

  _ctx(payload) {
    const extras = payload?.extras || {};
    const data = payload?.data || payload?.inputData || {};
    if (!extras.locationId) throw Object.assign(new Error('Missing locationId'), { statusCode: 400 });
    return { locationId: extras.locationId, contactId: extras.contactId, data };
  }

  async _failed(locationId, contactId, error, text) {
    await this.fireTrigger(TRIGGERS.MESSAGE_FAILED, locationId, {
      locationId,
      contactId,
      messageText: text || '',
      errorMessage: error.message,
      errorCode: error.code || '',
      timestamp: new Date().toISOString(),
    });
  }

  async sendMessage(payload) {
    const { locationId, contactId, data } = this._ctx(payload);
    const text = field(data, 'message', 'text', 'body');
    if (!contactId) throw Object.assign(new Error('This action needs a contact'), { code: 'NO_PHONE' });
    try {
      const r = await this.messaging.send({ locationId, contactId, text, source: 'workflow', mirror: true, preferredSessionId: numberRef(data) });
      return { sent: true, whatsappMessageId: r.waMessageIds[0], linkedNumber: r.session.phoneNumber };
    } catch (err) {
      this._failed(locationId, contactId, err, text).catch(() => {});
      throw err;
    }
  }

  async sendMedia(payload) {
    const { locationId, contactId, data } = this._ctx(payload);
    const url = field(data, 'mediaUrl', 'url', 'fileUrl');
    const caption = field(data, 'caption', 'message');
    if (!url) throw Object.assign(new Error('Media URL is required'), { code: 'EMPTY' });
    try {
      const r = await this.messaging.send({ locationId, contactId, text: caption, attachments: [url], source: 'workflow', mirror: true, preferredSessionId: numberRef(data) });
      return { sent: true, whatsappMessageId: r.waMessageIds[0] };
    } catch (err) {
      this._failed(locationId, contactId, err, caption).catch(() => {});
      throw err;
    }
  }

  /** Send to an arbitrary number (e.g. notify the owner / a staff member). Not mirrored to a contact. */
  async sendToNumber(payload) {
    const { locationId, data } = this._ctx(payload);
    const phone = field(data, 'phone', 'phoneNumber', 'to');
    const text = field(data, 'message', 'text');
    if (!phone) throw Object.assign(new Error('Phone number is required'), { code: 'NO_PHONE' });
    try {
      const r = await this.messaging.send({ locationId, phone, text, attachments: [field(data, 'mediaUrl')].filter(Boolean), source: 'workflow', preferredSessionId: numberRef(data) });
      return { sent: true, whatsappMessageId: r.waMessageIds[0] };
    } catch (err) {
      this._failed(locationId, null, err, text).catch(() => {});
      throw err;
    }
  }

  /** Returns { onWhatsApp: 'yes'|'no' } — branch a workflow on it. */
  async checkNumber(payload) {
    const { locationId, contactId, data } = this._ctx(payload);
    let phone = field(data, 'phone', 'phoneNumber');
    if (!phone && contactId) {
      const c = await this.messaging.ghl.getContact(locationId, contactId);
      phone = c?.phone || '';
    }
    if (!phone) return { onWhatsApp: 'no', phone: '' };
    const session = await this.messaging.pickSession(locationId, { preferredSessionId: numberRef(data) });
    const hit = await this.manager.lookupNumber(session._id, phone);
    return { onWhatsApp: hit.exists ? 'yes' : 'no', phone };
  }
}

module.exports = WorkflowsService;
