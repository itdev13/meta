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
