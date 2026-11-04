const mongoose = require('mongoose');

/**
 * Agency (company) → its sub-accounts. `locationIds` is the authoritative membership list used
 * to authorise agency-scope sessions; `locations` is a cached directory (name, contact info)
 * for the agency dashboard, refreshed from /locations/search with the company token.
 */
const LocationEntrySchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    city: { type: String, default: '' },
    country: { type: String, default: '' },
    logoUrl: { type: String, default: '' },
  },
  { _id: false },
);

const CompanyLocationSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, unique: true, index: true },
    companyName: { type: String, default: '' },
    locationIds: { type: [String], default: [], index: true },
    locations: { type: [LocationEntrySchema], default: [] },
    syncedAt: { type: Date },
  },
  { collection: 'company_locations', timestamps: true },
);

module.exports = mongoose.model('CompanyLocation', CompanyLocationSchema);
