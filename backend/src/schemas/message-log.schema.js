const mongoose = require('mongoose');

/**
 * Every message we moved, both directions. Used for dedup (WhatsApp re-delivers on reconnect),
 * receipt → GHL status mapping (waMessageId ↔ ghlMessageId), echo suppression (our own sends
 * arrive back as fromMe), and the activity feeds. Auto-expires after 90 days.
 */
const MessageLogSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, index: true },
    companyId: { type: String, index: true },
    sessionId: { type: String, required: true, index: true },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    // ghl = agent sent from the CRM, workflow = workflow action, phone = typed on the phone,
    // contact = the customer wrote to us, auto = auto-reply / keyword rule / opt-out confirmation.
    source: { type: String, enum: ['ghl', 'workflow', 'phone', 'contact', 'auto'], required: true },
    isGroup: { type: Boolean, default: false },
    // Set by the rules feature when an inbound matched a keyword rule.
    keyword: { type: String },
    waJid: { type: String },
    waMessageId: { type: String },
    ghlMessageId: { type: String, index: true },
    ghlContactId: { type: String },
    kind: { type: String, default: 'text' }, // text | image | video | audio | document | sticker | location | contact | reaction | other
    preview: { type: String, default: '' },   // first 140 chars, for the activity feed
    status: { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'failed'], default: 'sent' },
    error: { type: String, default: '' },
    // feature: routing — which rule picked the sending number (outbound only):
    // explicit | override | tag | assigned_user | sender | last_used | default | recent | group
    routedBy: { type: String },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), index: { expires: 0 } },
  },
  { collection: 'message_logs', timestamps: { createdAt: true, updatedAt: true } },
);

MessageLogSchema.index({ sessionId: 1, waMessageId: 1 }, { unique: true, partialFilterExpression: { waMessageId: { $type: 'string' } } });
MessageLogSchema.index({ locationId: 1, createdAt: -1 });
MessageLogSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model('MessageLog', MessageLogSchema);
