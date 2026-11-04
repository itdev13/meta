const mongoose = require('mongoose');

const ArchivedTokenSchema = new mongoose.Schema(
  {
    companyId: { type: String, index: true },
    locationId: { type: String, required: true, index: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    originalCreatedAt: { type: Date },
    originalExpiresAt: { type: Date },
    deletedAt: { type: Date, default: () => new Date() },
    deletionReason: { type: String },
    uninstallWebhookData: { type: Object },
    autoDeleteAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      index: { expires: 0 },
    },
  },
  { collection: 'archived_tokens', timestamps: true },
);

module.exports = mongoose.model('ArchivedToken', ArchivedTokenSchema);
