const mongoose = require('mongoose');

/**
 * Rules feature collections (all prefixed `rules_`):
 *   rules_templates  — reusable message templates with {{variables}}
 *   rules_keywords   — keyword rules ("Reply C to confirm…"), evaluated in priority order
 *   rules_settings   — one doc per location: away message / business hours + welcome message
 *   rules_cooldowns  — per-contact "last sent" state, so auto-replies never loop or spam
 *   rules_hits       — one row per fired rule / away / welcome, for 30-day stats (TTL 35d)
 */
const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

// ── Templates ──────────────────────────────────────────────────
const TemplateSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    nameKey: { type: String, required: true }, // lower-cased name, for unique + by-name lookups
    body: { type: String, default: '', maxlength: 4096 },
    mediaUrl: { type: String, default: '', trim: true },
    category: { type: String, default: 'general', trim: true, maxlength: 40 },
    usageCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date },
    createdBy: { userId: String, name: String },
  },
  { collection: 'rules_templates', timestamps: true },
);
TemplateSchema.index({ locationId: 1, nameKey: 1 }, { unique: true });

// ── Keyword rules ──────────────────────────────────────────────
const RuleSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    enabled: { type: Boolean, default: true },
    priority: { type: Number, default: 0 }, // ascending: 0 is checked first
    matchType: { type: String, enum: ['exact', 'contains', 'starts_with'], default: 'exact' },
    keywords: { type: [String], default: [] },
    sessionIds: { type: [String], default: [] }, // empty = every linked number
    reply: {
      mode: { type: String, enum: ['none', 'text', 'template'], default: 'text' },
      text: { type: String, default: '', maxlength: 4096 },
      templateId: { type: String, default: '' },
    },
    tags: { type: [String], default: [] },
    fireTrigger: { type: Boolean, default: true },
    cooldownMinutes: { type: Number, default: 60, min: 0, max: 60 * 24 * 30 },
    hitCount: { type: Number, default: 0 },
    lastTriggeredAt: { type: Date },
  },
  { collection: 'rules_keywords', timestamps: true },
);
RuleSchema.index({ locationId: 1, priority: 1 });

// ── Away + welcome settings ────────────────────────────────────
const DaySchema = new mongoose.Schema(
  { open: { type: Boolean, default: true }, start: { type: String, default: '09:00' }, end: { type: String, default: '17:00' } },
  { _id: false },
);
const SettingsSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true, unique: true },
    away: {
      enabled: { type: Boolean, default: false },
      timezone: { type: String, default: '' }, // '' = location timezone, else UTC
      // index 0 = Sunday … 6 = Saturday
      schedule: { type: [DaySchema], default: undefined },
      message: { type: String, default: '', maxlength: 4096 },
      templateId: { type: String, default: '' },
      cooldownHours: { type: Number, default: 12, min: 0, max: 24 * 30 },
      sessionIds: { type: [String], default: [] },
    },
    welcome: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: '', maxlength: 4096 },
      templateId: { type: String, default: '' },
      sessionIds: { type: [String], default: [] },
    },
  },
  { collection: 'rules_settings', timestamps: true },
);

// ── Per-contact cooldowns ──────────────────────────────────────
const CooldownSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true },
    contactId: { type: String, required: true },
    key: { type: String, required: true }, // rule:<id> | away | welcome
    lastAt: { type: Date, required: true },
    expiresAt: { type: Date, index: { expires: 0 } },
  },
  { collection: 'rules_cooldowns' },
);
CooldownSchema.index({ locationId: 1, contactId: 1, key: 1 }, { unique: true });

// ── Hits (stats) ───────────────────────────────────────────────
const HitSchema = new mongoose.Schema(
  {
    locationId: { type: String, required: true },
    kind: { type: String, enum: ['rule', 'away', 'welcome'], required: true },
    ruleId: { type: String, default: '' },
    keyword: { type: String, default: '' },
    contactId: { type: String, default: '' },
    sessionId: { type: String, default: '' },
    replied: { type: Boolean, default: false },
    at: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 35 * 24 * 60 * 60 * 1000), index: { expires: 0 } },
  },
  { collection: 'rules_hits' },
);
HitSchema.index({ locationId: 1, at: -1 });

const DEFAULT_SCHEDULE = [
  { open: false, start: '09:00', end: '17:00' }, // Sun
  { open: true, start: '09:00', end: '17:00' },
  { open: true, start: '09:00', end: '17:00' },
  { open: true, start: '09:00', end: '17:00' },
  { open: true, start: '09:00', end: '17:00' },
  { open: true, start: '09:00', end: '17:00' },
  { open: false, start: '09:00', end: '17:00' }, // Sat
];

module.exports = {
  Template: model('RuleTemplate', TemplateSchema),
  Rule: model('KeywordRule', RuleSchema),
  Settings: model('RuleSettings', SettingsSchema),
  Cooldown: model('RuleCooldown', CooldownSchema),
  Hit: model('RuleHit', HitSchema),
  DEFAULT_SCHEDULE,
};
