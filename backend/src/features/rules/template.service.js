const axios = require('axios');

/**
 * Renders {{variables}} in message text.
 *
 *   {{first_name}} {{last_name}} {{name}} {{phone}} {{email}} {{business_name}} {{date}} {{time}}
 *   {{contact.<field>}}   any GHL contact field (camelCase or snake_case), or a custom field by
 *                         its key (e.g. {{contact.favourite_color}}) or id
 *   {{first_name|there}}  fallback when the value is empty / unknown
 *
 * Unknown variables render as ''. Contact + location lookups are lazy (only when the text needs
 * them); the location (name, timezone) and custom-field keys are cached.
 */
const VAR_RE = /\{\{\s*([a-zA-Z0-9_.\-]+)\s*(?:\|([^}]*))?\}\}/g;
const LOCATION_TTL = 30 * 60 * 1000;
const FIELDS_TTL = 10 * 60 * 1000;
const NEG_TTL = 2 * 60 * 1000;

const CONTACT_VARS = new Set(['first_name', 'last_name', 'name', 'full_name', 'phone', 'email']);

const SAMPLE_CONTACT = {
  id: 'sample',
  firstName: 'Alex',
  lastName: 'Morgan',
  name: 'Alex Morgan',
  phone: '+14155550123',
  email: 'alex@example.com',
  companyName: 'Morgan & Co',
  city: 'San Francisco',
  customFields: [],
};

const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const str = (v) => (v === undefined || v === null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? '' : String(v));

function validTimezone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

class TemplateService {
  constructor(ghlService) {
    this.ghl = ghlService;
    this._locations = new Map(); // locationId → { at, ttl, data:{ name, timezone } }
    this._fieldKeys = new Map(); // locationId → { at, ttl, map: { key → id } }
  }

  /** Variable names (without braces) used in a text. */
  static variablesIn(text) {
    const out = [];
    for (const m of String(text || '').matchAll(VAR_RE)) out.push(m[1]);
    return [...new Set(out)];
  }

  static hasVariables(text) {
    return typeof text === 'string' && text.includes('{{');
  }

  async location(locationId) {
    const hit = this._locations.get(locationId);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.data;
    try {
      const loc = await this.ghl.getLocation(locationId);
      const data = { name: loc?.name || loc?.business?.name || '', timezone: loc?.timezone || loc?.business?.timezone || '' };
      this._locations.set(locationId, { at: Date.now(), ttl: LOCATION_TTL, data });
      return data;
    } catch {
      const data = hit?.data || { name: '', timezone: '' };
      this._locations.set(locationId, { at: Date.now(), ttl: NEG_TTL, data });
      return data;
    }
  }

  /** Location timezone if known and valid, else the given fallback, else UTC. */
  async timezone(locationId, preferred) {
    if (validTimezone(preferred)) return preferred;
    const loc = await this.location(locationId);
    return validTimezone(loc.timezone) ? loc.timezone : 'UTC';
  }

  /** Custom field key → id for {{contact.<custom_key>}}. Never throws. */
  async _customFieldKeys(locationId) {
    const hit = this._fieldKeys.get(locationId);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.map;
    const map = {};
    try {
      const res = await this.ghl._apiRequest(locationId, (t) =>
        axios.get(`${this.ghl.apiBase}/locations/${locationId}/customFields`, { params: { model: 'contact' }, headers: this.ghl._headers(t, false), timeout: 10_000 }),
      );
      for (const f of res?.data?.customFields || []) {
        const key = String(f.fieldKey || '').replace(/^contact\./, '').toLowerCase();
        if (key && f.id) map[key] = f.id;
      }
      this._fieldKeys.set(locationId, { at: Date.now(), ttl: FIELDS_TTL, map });
    } catch {
      this._fieldKeys.set(locationId, { at: Date.now(), ttl: NEG_TTL, map });
    }
    return map;
  }

  async _contactField(locationId, contact, path) {
    if (!contact || !path) return '';
    const direct = contact[path] ?? contact[snakeToCamel(path)];
    if (direct !== undefined && direct !== null && typeof direct !== 'object') return str(direct);
    if (Array.isArray(direct)) return str(direct);
    const custom = contact.customFields || contact.customField || [];
    if (!Array.isArray(custom) || !custom.length) return '';
    const byId = custom.find((f) => f.id === path);
    if (byId) return str(byId.value ?? byId.field_value);
    const keys = await this._customFieldKeys(locationId);
    const id = keys[path.toLowerCase()];
    const f = id && custom.find((x) => x.id === id);
    return f ? str(f.value ?? f.field_value) : '';
  }

  /**
   * Render text. opts: { contactId, contact (pre-fetched or SAMPLE), sample: true → sample contact,
   * now: Date, timezone }. Returns { text, missing: [vars that rendered empty without fallback] }.
   * Never throws — a failed lookup just renders that variable empty / fallback.
   */
  async renderDetailed(locationId, text, opts = {}) {
    const source = String(text ?? '');
    if (!TemplateService.hasVariables(source)) return { text: source, missing: [] };
    const vars = TemplateService.variablesIn(source);
    const needsContact = vars.some((v) => CONTACT_VARS.has(v) || v.startsWith('contact.'));
    const needsLocation = vars.some((v) => v === 'business_name' || v === 'location_name' || v === 'date' || v === 'time');

    let contact = opts.contact || null;
    if (!contact && opts.sample) contact = SAMPLE_CONTACT;
    if (!contact && needsContact && opts.contactId) {
      try {
        contact = await this.ghl.getContact(locationId, opts.contactId);
      } catch {
        contact = null;
      }
    }
    let loc = { name: '', timezone: '' };
    let tz = 'UTC';
    if (needsLocation) {
      loc = await this.location(locationId);
      tz = await this.timezone(locationId, opts.timezone);
    }
    const now = opts.now || new Date();

    const values = {};
    for (const v of vars) {
      try {
        values[v] = await this._value(locationId, v, { contact, loc, tz, now });
      } catch {
        values[v] = '';
      }
    }
    const missing = [];
    const out = source.replace(VAR_RE, (_, name, fallback) => {
      const val = values[name] || '';
      if (val) return val;
      if (fallback !== undefined) return fallback.trim();
      missing.push(name);
      return '';
    });
    return { text: out, missing: [...new Set(missing)] };
  }

  async render(locationId, text, opts = {}) {
    return (await this.renderDetailed(locationId, text, opts)).text;
  }

  async _value(locationId, name, { contact, loc, tz, now }) {
    const c = contact || {};
    const first = str(c.firstName || c.first_name);
    const last = str(c.lastName || c.last_name);
    switch (name) {
      case 'first_name':
        return first || str(c.name || c.contactName).split(/\s+/)[0] || '';
      case 'last_name':
        return last;
      case 'name':
      case 'full_name':
        return str(c.name || c.contactName) || [first, last].filter(Boolean).join(' ');
      case 'phone':
        return str(c.phone);
      case 'email':
        return str(c.email);
      case 'business_name':
      case 'location_name':
        return loc.name || '';
      case 'date':
        return new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium' }).format(now);
      case 'time':
        return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeStyle: 'short' }).format(now);
      default:
        if (name.startsWith('contact.')) return this._contactField(locationId, contact, name.slice(8));
        return '';
    }
  }
}

module.exports = { TemplateService, SAMPLE_CONTACT, validTimezone, VAR_RE };
