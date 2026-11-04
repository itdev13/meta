const mongoose = require('mongoose');

/**
 * Abuse-proof record that a location has ALREADY used its free trial. Written on first
 * install and NEVER deleted (not on uninstall) — so a user can't uninstall/reinstall to
 * get a fresh 3-day trial. Mirrors HelmDesk's TrialLedger.
 */
const TrialLedgerSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, unique: true, index: true },
    companyId: { type: String },
    firstTrialStartedAt: { type: Date, default: Date.now },
    trialEndsAt: { type: Date },
    planId: { type: String },
  },
  { collection: 'trial_ledger', timestamps: true },
);

module.exports = mongoose.model('TrialLedger', TrialLedgerSchema);
