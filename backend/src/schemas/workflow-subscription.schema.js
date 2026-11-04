const mongoose = require('mongoose');

const WorkflowSubscriptionSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true },
    companyId: { type: String, required: true },
    workflowId: { type: String, required: true },
    triggerKey: { type: String, required: true },
    targetUrl: { type: String, required: true },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    extras: { type: mongoose.Schema.Types.Mixed, default: {} },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, default: 'active' },
  },
  { collection: 'workflow_subscriptions', timestamps: true },
);

// Efficient lookup when firing triggers for a location
WorkflowSubscriptionSchema.index({ locationId: 1, triggerKey: 1, status: 1 });

// Prevent duplicate subscriptions per workflow+trigger
WorkflowSubscriptionSchema.index({ workflowId: 1, triggerKey: 1 }, { unique: true });

module.exports = mongoose.model('WorkflowSubscription', WorkflowSubscriptionSchema);
