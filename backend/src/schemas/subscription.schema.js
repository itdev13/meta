const mongoose = require('mongoose');

/**
 * One subscription per location, mirroring GHL Marketplace plan entitlement (GHL collects the
 * money). status: trialing | active (entitled) · past_due | canceled | inactive (not entitled).
 */
const SubscriptionSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, unique: true, index: true },
    companyId: { type: String, index: true },
    appId: { type: String },
    planId: { type: String },
    planName: { type: String },
    priceUsd: { type: Number },
    numberLimit: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['active', 'trialing', 'past_due', 'canceled', 'inactive'],
      default: 'inactive',
      index: true,
    },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },
    trialEndsAt: { type: Date },
    canceledAt: { type: Date },
    rawWebhookData: { type: mongoose.Schema.Types.Mixed },
  },
  { collection: 'subscriptions', timestamps: true },
);

SubscriptionSchema.methods.isEntitled = function isEntitled() {
  return this.status === 'active' || this.status === 'trialing';
};

module.exports = mongoose.model('Subscription', SubscriptionSchema);
