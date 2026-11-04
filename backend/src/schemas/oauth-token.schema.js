const mongoose = require('mongoose');

/**
 * OAuth tokens, separated from the install record (installations) so token lifecycle and
 * install status never desync. One row per token: a 'location' token (per sub-account) or a
 * 'company' token (agency install, used to mint location tokens lazily). Tokens are stored
 * encrypted. Adapted from convoVault's OAuthToken model.
 */
const OAuthTokenSchema = new mongoose.Schema(
  {
    locationId: { type: String, index: true }, // absent for company-level tokens
    companyId: { type: String, required: true, index: true },
    tokenType: { type: String, enum: ['location', 'company'], required: true, default: 'location' },

    accessToken: { type: String, required: true },   // encrypted
    refreshToken: { type: String, required: true },  // encrypted
    expiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
  },
  { collection: 'oauth_tokens', timestamps: true },
);

// One location token and one company token per key.
OAuthTokenSchema.index({ locationId: 1, tokenType: 1 }, { unique: true, partialFilterExpression: { locationId: { $exists: true } } });
OAuthTokenSchema.index({ companyId: 1, tokenType: 1 });

OAuthTokenSchema.methods.needsRefresh = function needsRefresh() {
  return new Date(Date.now() + 5 * 60 * 1000) >= this.expiresAt;
};

OAuthTokenSchema.statics.findActiveToken = function findActiveToken(locationId) {
  return this.findOne({ locationId, tokenType: 'location', isActive: true });
};

OAuthTokenSchema.statics.findActiveCompanyToken = function findActiveCompanyToken(companyId) {
  return this.findOne({ companyId, tokenType: 'company', isActive: true });
};

module.exports = mongoose.model('OAuthToken', OAuthTokenSchema);
