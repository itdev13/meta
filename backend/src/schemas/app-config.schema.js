const mongoose = require('mongoose');

/**
 * AppConfig — key-value store for app-wide settings that can be updated without redeploying.
 *
 * Usage:
 *   // In MongoDB, one document per key:
 *   { key: "internalTestingCompanyIds", values: ["PG9VJ27Q...", "7IlT9P1b..."] }
 *
 *   // In code:
 *   const ids = await AppConfig.getValues('internalTestingCompanyIds');
 */
const appConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    values: {
      type: [String],
      default: [],
    },
    description: {
      type: String,
      default: '',
    },
  },
  { timestamps: true },
);

// In-memory cache: { key: { values, expiresAt } }
const cache = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get values for a config key (cached for 5 minutes)
 */
appConfigSchema.statics.getValues = async function (key, fallback = []) {
  const now = Date.now();
  if (cache[key] && cache[key].expiresAt > now) {
    return cache[key].values;
  }

  const doc = await this.findOne({ key }).lean();
  const values = doc?.values || fallback;

  cache[key] = { values, expiresAt: now + CACHE_TTL_MS };
  return values;
};

/**
 * Check if a value exists in a config key's list
 */
appConfigSchema.statics.hasValue = async function (key, value) {
  const values = await this.getValues(key);
  return values.includes(value);
};

/**
 * Clear cache for a key (or all keys)
 */
appConfigSchema.statics.clearCache = function (key) {
  if (key) {
    delete cache[key];
  } else {
    Object.keys(cache).forEach((k) => delete cache[k]);
  }
};

module.exports = mongoose.model('AppConfig', appConfigSchema);
