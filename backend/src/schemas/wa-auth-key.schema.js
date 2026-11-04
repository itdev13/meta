const mongoose = require('mongoose');

/**
 * Baileys auth state (creds + signal keys) for one session, one row per key, value encrypted
 * with AES-256-GCM. Equivalent of useMultiFileAuthState but in Mongo so sessions survive
 * redeploys and can move between instances.
 */
const WaAuthKeySchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    value: { type: String, required: true },
  },
  { collection: 'wa_auth_keys', timestamps: { createdAt: false, updatedAt: true } },
);

WaAuthKeySchema.index({ sessionId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('WaAuthKey', WaAuthKeySchema);
