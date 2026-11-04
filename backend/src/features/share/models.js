const mongoose = require('mongoose');

/**
 * A one-time, expiring "connect your WhatsApp" link an agency / sub-account user sends to a
 * client. Only the sha256 of the token is stored — the raw token exists in the URL alone.
 *
 * lifecycle: created → (client starts linking: sessionId set) → usedAt (number connected)
 *            any time → revokedAt (creator revoked) | expiresAt passes (TTL removes the row)
 */
const ShareLinkSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    locationId: { type: String, required: true, index: true },
    companyId: { type: String, default: '' },
    // Existing (not connected) number this link re-links; null = a new number is created on start.
    numberId: { type: String, default: null },
    // The wa_sessions row driving the link once the client presses start.
    sessionId: { type: String, default: null, index: true },
    label: { type: String, default: '' },
    businessName: { type: String, default: '' }, // snapshot for the public page (best-effort)
    createdBy: { userId: String, name: String, scope: String },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    method: { type: String, enum: ['qr', 'code', null], default: null },
  },
  { collection: 'share_links', timestamps: true },
);

// Mongo deletes the row once expiresAt passes (on use, expiresAt is pushed to ≥ usedAt + 10 min).
ShareLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ShareLinkSchema.index({ locationId: 1, revokedAt: 1, expiresAt: -1 });

module.exports = { ShareLink: mongoose.models.ShareLink || mongoose.model('ShareLink', ShareLinkSchema) };
