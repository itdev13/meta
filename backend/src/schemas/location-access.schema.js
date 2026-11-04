const mongoose = require('mongoose');

/**
 * Per sub-account access decision made by the agency, plus any pending access request from
 * the sub-account. `enabled` is tri-state: true (explicitly on), false (explicitly off),
 * null (follow the agency's accessMode).
 */
const LocationAccessSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, index: true },
    locationId: { type: String, required: true, unique: true, index: true },
    enabled: { type: Boolean, default: null },
    numberLimit: { type: Number, default: null },
    note: { type: String, default: '' },
    request: {
      status: { type: String, enum: ['none', 'pending', 'approved', 'declined'], default: 'none' },
      requestedAt: { type: Date },
      requestedBy: { userId: String, name: String, email: String },
      message: { type: String, default: '' },
      decidedAt: { type: Date },
    },
    updatedBy: { type: String, default: '' },
  },
  { collection: 'location_access', timestamps: true },
);

module.exports = mongoose.model('LocationAccess', LocationAccessSchema);
