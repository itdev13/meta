const mongoose = require('mongoose');

/**
 * Consent feature collections (all prefixed `consent_`).
 *
 *   consent_settings  — one per location: keywords, confirmation replies, enforcement, tagging.
 *   consent_contacts  — current consent state per contact (keyed by GHL contactId; phone/jid kept
 *                       so a send to a raw number, or a number blocked before it became a
 *                       contact, is still caught).
 *   consent_events    — append-only audit log. Every change, with what caused it and who did it.
 */

const DEFAULT_OPT_OUT = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'STOPALL'];
const DEFAULT_OPT_IN = ['START', 'UNSTOP', 'SUBSCRIBE', 'YES'];
const DEFAULT_OPT_OUT_REPLY = 'You’ve been unsubscribed and won’t receive more WhatsApp messages from us. Reply START to subscribe again.';
const DEFAULT_OPT_IN_REPLY = 'You’re subscribed to WhatsApp messages from us again. Reply STOP at any time to unsubscribe.';
const DEFAULT_TAG = 'whatsapp-opted-out';

const STATUSES = ['opted_in', 'opted_out', 'unknown'];
const METHODS = ['inbound_message', 'keyword', 'workflow', 'manual', 'import'];

// ── Settings ─────────────────────────────────────────────────────
const ConsentSettingsSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, unique: true, index: true },
    optOutKeywords: { type: [String], default: () => [...DEFAULT_OPT_OUT] },
    optInKeywords: { type: [String], default: () => [...DEFAULT_OPT_IN] },
    optOutReplyEnabled: { type: Boolean, default: true },
    optOutReply: { type: String, default: DEFAULT_OPT_OUT_REPLY },
    optInReplyEnabled: { type: Boolean, default: true },
    optInReply: { type: String, default: DEFAULT_OPT_IN_REPLY },
    implicitOptInOnInbound: { type: Boolean, default: true },
    enforce: { type: Boolean, default: true },
    tagOnOptOut: { type: Boolean, default: true },
    optOutTag: { type: String, default: DEFAULT_TAG },
    updatedBy: { type: String, default: '' },
  },
  { collection: 'consent_settings', timestamps: true },
);

// ── Current state per contact ────────────────────────────────────
const ConsentContactSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true },
    contactId: { type: String, default: null }, // GHL contact id (null only for a number blocked before it was a contact)
    phone: { type: String, default: '' },       // E.164
    waJid: { type: String, default: null },     // <digits>@s.whatsapp.net
    lidJid: { type: String, default: null },    // <id>@lid
    name: { type: String, default: '' },
    status: { type: String, enum: STATUSES, default: 'unknown' },
    lastMethod: { type: String, enum: METHODS },
    lastEventAt: { type: Date },
    optedInAt: { type: Date },
    optedOutAt: { type: Date },
    sessionId: { type: String, default: '' }, // linked number the last change came through
  },
  { collection: 'consent_contacts', timestamps: true },
);

ConsentContactSchema.index({ locationId: 1, contactId: 1 }, { unique: true, partialFilterExpression: { contactId: { $type: 'string' } } });
ConsentContactSchema.index({ locationId: 1, waJid: 1 }, { partialFilterExpression: { waJid: { $type: 'string' } } });
ConsentContactSchema.index({ locationId: 1, lidJid: 1 }, { partialFilterExpression: { lidJid: { $type: 'string' } } });
ConsentContactSchema.index({ locationId: 1, phone: 1 });
ConsentContactSchema.index({ locationId: 1, status: 1, lastEventAt: -1 });
ConsentContactSchema.index({ locationId: 1, lastEventAt: -1 });

// ── Append-only audit log ────────────────────────────────────────
const ConsentEventSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true },
    consentContactId: { type: mongoose.Schema.Types.ObjectId },
    contactId: { type: String, default: null },
    phone: { type: String, default: '' },
    waJid: { type: String, default: '' },
    contactName: { type: String, default: '' },
    event: { type: String, enum: ['opted_in', 'opted_out'], required: true },
    previousStatus: { type: String, enum: STATUSES, default: 'unknown' },
    channel: { type: String, default: 'whatsapp' },
    method: { type: String, enum: METHODS, required: true },
    keyword: { type: String, default: '' }, // matched keyword (method = keyword)
    text: { type: String, default: '' },    // the message that caused it (first 500 chars)
    note: { type: String, default: '' },    // reason for manual / workflow changes
    actor: {
      type: { type: String, enum: ['contact', 'user', 'workflow', 'system'], default: 'system' },
      id: { type: String, default: '' },
      name: { type: String, default: '' },
      email: { type: String, default: '' },
    },
    sessionId: { type: String, default: '' },
    linkedNumber: { type: String, default: '' },
    workflowId: { type: String, default: '' },
  },
  { collection: 'consent_events', timestamps: { createdAt: true, updatedAt: false } },
);

ConsentEventSchema.index({ locationId: 1, createdAt: -1 });
ConsentEventSchema.index({ locationId: 1, consentContactId: 1, createdAt: -1 });
ConsentEventSchema.index({ locationId: 1, event: 1, createdAt: -1 });

// Audit log is append-only: refuse every update / delete issued through the model.
function appendOnly() {
  throw Object.assign(new Error('consent_events is append-only'), { code: 'APPEND_ONLY', statusCode: 500 });
}
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  ConsentEventSchema.pre(op, appendOnly);
}
ConsentEventSchema.pre('save', function onlyNew(next) {
  if (!this.isNew) return next(Object.assign(new Error('consent_events is append-only'), { code: 'APPEND_ONLY' }));
  return next();
});

const ConsentSettings = mongoose.models.ConsentSettings || mongoose.model('ConsentSettings', ConsentSettingsSchema);
const ConsentContact = mongoose.models.ConsentContact || mongoose.model('ConsentContact', ConsentContactSchema);
const ConsentEvent = mongoose.models.ConsentEvent || mongoose.model('ConsentEvent', ConsentEventSchema);

module.exports = {
  ConsentSettings,
  ConsentContact,
  ConsentEvent,
  STATUSES,
  METHODS,
  DEFAULTS: {
    optOutKeywords: DEFAULT_OPT_OUT,
    optInKeywords: DEFAULT_OPT_IN,
    optOutReplyEnabled: true,
    optOutReply: DEFAULT_OPT_OUT_REPLY,
    optInReplyEnabled: true,
    optInReply: DEFAULT_OPT_IN_REPLY,
    implicitOptInOnInbound: true,
    enforce: true,
    tagOnOptOut: true,
    optOutTag: DEFAULT_TAG,
  },
};
