const mongoose = require('mongoose');

/**
 * Agency-wide controls. One per company.
 *
 * accessMode
 *   'all'      — every sub-account may use WhatsApp unless the agency explicitly blocks it
 *   'selected' — only sub-accounts the agency explicitly enables may use it
 *
 * allowSelfConnect — when false, sub-account users can VIEW their numbers but only the agency
 *   can link / unlink numbers (agency scans the QR on the client's behalf).
 */
const AgencySettingsSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, unique: true, index: true },
    // Default OFF: a sub-account gets WhatsApp only after the agency switches it on.
    accessMode: { type: String, enum: ['all', 'selected'], default: 'selected' },
    allowSelfConnect: { type: Boolean, default: true },
    allowAccessRequests: { type: Boolean, default: true },
    // Cap applied to every sub-account on top of its plan (null = plan limit only).
    defaultNumberLimit: { type: Number, default: null },
    // Sending pace defaults for new numbers (anti-ban).
    defaultMinDelayMs: { type: Number, default: null },
    defaultDailyLimit: { type: Number, default: null },
    updatedBy: { type: String, default: '' },
  },
  { collection: 'agency_settings', timestamps: true },
);

module.exports = mongoose.model('AgencySettings', AgencySettingsSchema);
