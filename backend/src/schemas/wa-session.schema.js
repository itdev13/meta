const mongoose = require('mongoose');

/**
 * One linked WhatsApp number (a Baileys multi-device session). Many per location.
 *
 * status lifecycle
 *   pending → qr | pairing → connecting → connected
 *   connected → disconnected (transient, auto-reconnects) → connected
 *   * → logged_out (unlinked from phone / 401) | banned (403) | replaced (440, another client)
 *   * → paused (agency disabled the sub-account, or the plan limit dropped)
 *   qr | pairing → qr_expired (nobody scanned in time)
 *
 * isActive = we intend this session to be live. Restore-on-boot only starts active sessions.
 */
const STATUSES = [
  'pending', 'qr', 'pairing', 'connecting', 'connected', 'disconnected',
  'qr_expired', 'logged_out', 'banned', 'replaced', 'paused',
];

const WaSessionSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, index: true },
    companyId: { type: String, index: true },
    label: { type: String, default: '' },
    // Stable per-location number: "WhatsApp #<index>". Used by the {WA#n} routing override.
    index: { type: Number, index: true },
    // feature: routing — GHL user ids this number is assigned to.
    assignedUserIds: { type: [String], default: [] },

    phoneNumber: { type: String },        // E.164, set once linked
    waJid: { type: String },              // normalised own jid, e.g. 919999999999@s.whatsapp.net
    waName: { type: String, default: '' }, // push name on the phone
    platform: { type: String, default: '' },

    status: { type: String, enum: STATUSES, default: 'pending', index: true },
    pausedReason: { type: String, enum: ['', 'agency_disabled', 'plan_limit', 'manual'], default: '' },
    isActive: { type: Boolean, default: true, index: true },
    isDefault: { type: Boolean, default: false },
    registered: { type: Boolean, default: false }, // creds.registered — has ever completed pairing

    settings: {
      ignoreGroups: { type: Boolean, default: true },
      markRead: { type: Boolean, default: false },
      typingSimulation: { type: Boolean, default: true },
      syncPhoneReplies: { type: Boolean, default: true },
      // feature: groups. Off = group chats are dropped (legacy behaviour). On = each group syncs
      // as one CRM contact. (ignoreGroups above is legacy and unused.)
      syncGroups: { type: Boolean, default: false },
      // feature: groups. 'all' = every group syncs when syncGroups is on; 'selected' = only groups
      // explicitly enabled in the groups list.
      groupMode: { type: String, enum: ['all', 'selected'], default: 'all' },
      // feature: inbound controls
      doNotCreateContacts: { type: Boolean, default: false }, // unknown senders are dropped, not created
      disableIncoming: { type: Boolean, default: false },     // drop all inbound + phone-reply sync; sending still works
      blacklist: { type: [String], default: [] },             // E.164 numbers whose inbound is silently dropped
      // feature: proxy — ISO country code chosen from the configured proxy pool ('' = direct)
      proxyCountry: { type: String, default: '' },
      // feature: calls (WhatsApp Voice) — call history in the CRM, missed-call reply, auto-decline
      callLogging: { type: Boolean, default: true },
      missedCallReply: { type: Boolean, default: false },
      missedCallMessage: { type: String, default: 'Sorry we missed your call! Reply here and we will get back to you shortly.' },
      autoRejectCalls: { type: Boolean, default: false },
      // feature: inbound details — append "Received on WhatsApp #n" / Click-to-WhatsApp ad details
      receivedOnTag: { type: Boolean, default: false },
      adDetails: { type: Boolean, default: true },
      minDelayMs: { type: Number, default: null },
      dailyLimit: { type: Number, default: null },
    },

    stats: {
      sentDate: { type: String, default: '' }, // YYYY-MM-DD (UTC) the counter below belongs to
      sentToday: { type: Number, default: 0 },
      totalInbound: { type: Number, default: 0 },
      totalOutbound: { type: Number, default: 0 },
    },

    connectedAt: { type: Date },
    lastSeenAt: { type: Date },
    lastMessageAt: { type: Date },
    lastDisconnectAt: { type: Date },
    lastDisconnectCode: { type: Number },
    lastError: { type: String, default: '' },
    // feature: alerts — the open outage incident (one alert per outage, then capped reminders)
    alert: {
      open: { type: Boolean, default: false },
      reason: { type: String, default: '' },
      openedAt: { type: Date },
      lastSentAt: { type: Date },
      reminders: { type: Number, default: 0 },
    },

    // Single-owner lease so two server instances never run the same socket.
    ownerId: { type: String, default: null },
    leaseUntil: { type: Date, default: null },

    createdBy: { userId: String, name: String, scope: String },
  },
  { collection: 'wa_sessions', timestamps: true },
);

WaSessionSchema.index({ locationId: 1, phoneNumber: 1 });
WaSessionSchema.index({ companyId: 1, status: 1 });

WaSessionSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('WaSession', WaSessionSchema);
