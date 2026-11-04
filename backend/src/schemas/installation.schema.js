const mongoose = require('mongoose');

/**
 * One document per GHL sub-account (location) that has the app. Install metadata only —
 * tokens live in oauth_tokens, entitlement in subscriptions, numbers in wa_sessions.
 */
const InstallationSchema = new mongoose.Schema(
  {
    companyId: { type: String, index: true },
    locationId: { type: String, required: true, unique: true, index: true },
    locationName: { type: String, default: '' },
    status: { type: String, enum: ['active', 'uninstalled'], default: 'active', index: true },
    conversationProviderId: { type: String, default: '' },
    appId: { type: String },
    versionId: { type: String },
    whitelabelDomain: { type: String },
    installedAt: { type: Date, default: Date.now },
    uninstalledAt: { type: Date },
  },
  { collection: 'installations', timestamps: true },
);

module.exports = mongoose.model('Installation', InstallationSchema);
