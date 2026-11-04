const axios = require('axios');
const ContactMapping = require('../schemas/contact-mapping.schema');
const { jidToPhone, normalizeJid, isPnJid, isLidJid, digits } = require('./jid');

// feature: groups — group metadata cache (per number + group jid).
const GROUP_META_TTL_MS = 60 * 60 * 1000;
const GROUP_META_MAX = 5000;
const GROUP_PREFIX = '👥 ';
// feature: groups — per-group enable flag cache (locationId|groupJid → { value, at }).
const GROUP_FLAG_TTL_MS = 15 * 1000;
const GROUP_FLAG_MAX = 5000;

function groupDisplayName(subject) {
  return `${GROUP_PREFIX}${String(subject || 'WhatsApp group').trim()}`.slice(0, 100);
}

/** Baileys GroupMetadata → the small slice we keep in memory. */
function slimGroupMeta(meta) {
  const lidToPn = new Map();
  for (const p of meta?.participants || []) {
    const ids = [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean).map((x) => normalizeJid(x));
    const pn = ids.find(isPnJid);
    const lid = ids.find(isLidJid);
    if (pn && lid) lidToPn.set(lid, pn);
  }
  return {
    jid: normalizeJid(meta?.id),
    subject: String(meta?.subject || '').trim(),
    size: Number(meta?.size || meta?.participants?.length || 0),
    announce: !!meta?.announce,
    lidToPn,
  };
}

/**
 * WhatsApp identity ↔ GHL contact. Finds by phone jid OR LID so a person who shows up under
 * both is one contact; creates via GHL upsert-by-phone so existing CRM contacts are reused.
 */
class ContactService {
  constructor(ghlService) {
    this.ghl = ghlService;
    this._groupMeta = new Map(); // `${sessionId}|${groupJid}` → { meta, at }
    this._groupMetaInflight = new Map();
    this._groupInflight = new Map(); // `${locationId}|${groupJid}` → Promise (single-flight create)
    this._groupFlags = new Map(); // `${locationId}|${groupJid}` → { value: true|false|null, at }
  }

  async findByIdentity(locationId, { pnJid, lidJid }) {
    const or = [];
    if (pnJid) or.push({ waJid: pnJid });
    if (lidJid) or.push({ lidJid });
    if (!or.length) return null;
    return ContactMapping.findOne({ locationId, $or: or });
  }

  findByContact(locationId, ghlContactId) {
    return ContactMapping.findOne({ locationId, ghlContactId }).sort({ updatedAt: -1 });
  }

  /**
   * Resolve (or create) the GHL contact for an inbound WhatsApp sender.
   * Returns { mapping, created }.
   */
  async resolveInbound({ locationId, sessionId, linkedNumber, pnJid, lidJid, pushName }) {
    const phone = jidToPhone(pnJid);
    let mapping = await this.findByIdentity(locationId, { pnJid, lidJid });

    if (mapping) {
      const $set = { lastSessionId: sessionId, lastInboundAt: new Date() };
      if (pnJid && !mapping.waJid) $set.waJid = pnJid;
      if (lidJid && !mapping.lidJid) $set.lidJid = lidJid;
      if (phone && !mapping.phone) $set.phone = phone;
      if (pushName && pushName !== mapping.pushName) $set.pushName = pushName;
      await ContactMapping.updateOne({ _id: mapping._id }, { $set }).catch(() => {});
      return { mapping: Object.assign(mapping, $set), created: false };
    }

    const contact = await this._createGhlContact(locationId, { phone, pushName, pnJid, lidJid, linkedNumber });
    try {
      mapping = await ContactMapping.create({
        locationId,
        ghlContactId: contact.id,
        waJid: pnJid || null,
        lidJid: lidJid || null,
        phone,
        pushName: pushName || '',
        firstSessionId: sessionId,
        lastSessionId: sessionId,
        lastInboundAt: new Date(),
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
      mapping = await this.findByIdentity(locationId, { pnJid, lidJid }); // lost a race — use the winner
    }
    return { mapping, created: true };
  }

  /**
   * feature: inbound controls (doNotCreateContacts). Like resolveInbound but NEVER creates a GHL
   * contact: returns the existing mapping as-is, or links an existing GHL contact that matches
   * the sender's phone (creating only the local mapping). → { mapping, created:false } | null.
   * Callers then run resolveInbound as usual (it finds the mapping and refreshes it).
   * Throws only on DB errors; a failed GHL lookup counts as "not found".
   */
  async findExisting({ locationId, sessionId, pnJid, lidJid, pushName }) {
    const existing = await this.findByIdentity(locationId, { pnJid, lidJid });
    if (existing) return { mapping: existing, created: false };
    const phone = jidToPhone(pnJid);
    if (!phone) return null; // LID-only sender: nothing to search GHL by
    const contactId = await this.findGhlContactIdByPhone(locationId, phone);
    if (!contactId) return null;
    let mapping;
    try {
      mapping = await ContactMapping.create({
        locationId,
        ghlContactId: contactId,
        waJid: pnJid || null,
        lidJid: lidJid || null,
        phone,
        pushName: pushName || '',
        firstSessionId: sessionId,
        lastSessionId: sessionId,
        lastInboundAt: new Date(),
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
      mapping = await this.findByIdentity(locationId, { pnJid, lidJid }); // lost a race — use the winner
      if (!mapping) return null;
    }
    return { mapping, created: false };
  }

  /**
   * GHL contact id for an E.164 phone, WITHOUT upserting. Tries the duplicate-search endpoint
   * (same matching rules GHL's upsert uses), then the advanced search filtered on phone.
   * → contactId | null. Never throws.
   */
  async findGhlContactIdByPhone(locationId, phone) {
    const want = digits(phone);
    if (!want) return null;
    const api = this.ghl;
    try {
      const res = await api._apiRequest(locationId, (t) =>
        axios.get(`${api.apiBase}/contacts/search/duplicate`, { params: { locationId, number: `+${want}` }, headers: api._headers(t, false), timeout: 10_000 }),
      );
      const c = res?.data?.contact;
      if (c?.id) return c.id;
      if (res && res.status === 200) return null; // definitive "no duplicate"
    } catch {
      /* fall through to advanced search */
    }
    try {
      const res = await api._apiRequest(locationId, (t) =>
        axios.post(
          `${api.apiBase}/contacts/search`,
          { locationId, pageLimit: 5, filters: [{ field: 'phone', operator: 'eq', value: `+${want}` }] },
          { headers: api._headers(t), timeout: 10_000 },
        ),
      );
      const hit = (res?.data?.contacts || []).find((c) => digits(c.phone) === want) || null;
      return hit?.id || null;
    } catch (err) {
      console.warn(`[Contacts] phone lookup ${locationId} failed: ${err.message}`);
      return null;
    }
  }

  async _createGhlContact(locationId, { phone, pushName, pnJid, lidJid, linkedNumber }) {
    const customFields = await this.ghl.customFieldValues(locationId, {
      whatsapp_id: pnJid || lidJid,
      whatsapp_number: phone,
      whatsapp_linked_number: linkedNumber,
      whatsapp_first_seen: new Date().toISOString(),
    });
    const name = (pushName || '').trim();
    const [firstName, ...rest] = name ? name.split(/\s+/) : [phone || 'WhatsApp contact'];
    const fields = { firstName, lastName: rest.join(' '), tags: ['whatsapp'], ...(customFields.length ? { customFields } : {}) };
    if (phone) return this.ghl.upsertContact(locationId, { ...fields, phone });
    return this.ghl.createContact(locationId, fields);
  }

  /** Mapping for an outbound send to a GHL contact (creates/updates it once the jid is known). */
  async linkOutbound({ locationId, ghlContactId, sessionId, pnJid }) {
    const phone = jidToPhone(pnJid);
    const existing = await ContactMapping.findOne({ locationId, waJid: pnJid });
    if (existing) {
      await ContactMapping.updateOne({ _id: existing._id }, { $set: { ghlContactId, lastSessionId: sessionId, lastOutboundAt: new Date() } });
      return existing;
    }
    try {
      return await ContactMapping.create({
        locationId,
        ghlContactId,
        waJid: pnJid,
        phone,
        firstSessionId: sessionId,
        lastSessionId: sessionId,
        lastOutboundAt: new Date(),
      });
    } catch (err) {
      if (err.code === 11000) return ContactMapping.findOne({ locationId, waJid: pnJid });
      throw err;
    }
  }

  // ── Groups (feature: groups) ───────────────────────────────────

  /**
   * Group subject/size via sock.groupMetadata, cached ~1h per number + group. Throws if the
   * number is not a member (WhatsApp refuses the query). force=true bypasses the cache.
   */
  async groupMeta(sock, sessionId, groupJid, { force = false } = {}) {
    const key = `${sessionId}|${groupJid}`;
    const hit = this._groupMeta.get(key);
    if (!force && hit && Date.now() - hit.at < GROUP_META_TTL_MS) return hit.meta;
    if (this._groupMetaInflight.has(key)) return this._groupMetaInflight.get(key);
    const p = (async () => {
      const meta = slimGroupMeta(await sock.groupMetadata(groupJid));
      this.primeGroupMeta(sessionId, groupJid, meta);
      return meta;
    })().finally(() => this._groupMetaInflight.delete(key));
    this._groupMetaInflight.set(key, p);
    return p;
  }

  /** Seed the cache (e.g. from groupFetchAllParticipating). Accepts raw or slimmed metadata. */
  primeGroupMeta(sessionId, groupJid, meta) {
    const slim = meta?.lidToPn instanceof Map ? meta : slimGroupMeta(meta);
    this._groupMeta.delete(`${sessionId}|${groupJid}`);
    this._groupMeta.set(`${sessionId}|${groupJid}`, { meta: slim, at: Date.now() });
    if (this._groupMeta.size > GROUP_META_MAX) this._groupMeta.delete(this._groupMeta.keys().next().value);
    return slim;
  }

  /** Cached metadata only (no network). */
  cachedGroupMeta(sessionId, groupJid) {
    const hit = this._groupMeta.get(`${sessionId}|${groupJid}`);
    return hit && Date.now() - hit.at < GROUP_META_TTL_MS ? hit.meta : null;
  }

  /** The group's mapping WITH a GHL contact (placeholders that only carry groupEnabled are ignored). */
  findGroup(locationId, groupJid) {
    return ContactMapping.findOne({ locationId, waJid: groupJid, isGroup: true, ghlContactId: { $type: 'string' } });
  }

  /** Per-group flag: true | false | null (null = follow the number's groupMode). Cached ~15s. */
  async groupFlag(locationId, groupJid) {
    const key = `${locationId}|${groupJid}`;
    const hit = this._groupFlags.get(key);
    if (hit && Date.now() - hit.at < GROUP_FLAG_TTL_MS) return hit.value;
    const row = await ContactMapping.findOne({ locationId, waJid: groupJid, isGroup: true }).select('groupEnabled').lean();
    const value = typeof row?.groupEnabled === 'boolean' ? row.groupEnabled : null;
    this._cacheGroupFlag(key, value);
    return value;
  }

  _cacheGroupFlag(key, value) {
    this._groupFlags.delete(key);
    this._groupFlags.set(key, { value, at: Date.now() });
    if (this._groupFlags.size > GROUP_FLAG_MAX) this._groupFlags.delete(this._groupFlags.keys().next().value);
  }

  /**
   * Set the per-group flag. Updates the group's mapping, or upserts a contact-less placeholder
   * (ghlContactId null) so toggling never creates a CRM contact; resolveGroup fills the contact in
   * on the first synced message (or on /groups/link). → true | false.
   */
  async setGroupFlag(locationId, groupJid, enabled, { sessionId = '', subject = '' } = {}) {
    const value = !!enabled;
    const update = {
      $set: { groupEnabled: value, isGroup: true },
      $setOnInsert: { ghlContactId: null, groupSubject: String(subject || '').trim(), pushName: String(subject || '').trim(), firstSessionId: sessionId, lastSessionId: sessionId },
    };
    for (let attempt = 0; ; attempt++) {
      try {
        await ContactMapping.updateOne({ locationId, waJid: groupJid }, update, { upsert: true });
        break;
      } catch (err) {
        if (err.code !== 11000 || attempt) throw err; // concurrent upsert — the retry matches the winner
      }
    }
    this._cacheGroupFlag(`${locationId}|${groupJid}`, value);
    return value;
  }

  /**
   * Resolve (or create) the ONE GHL contact that represents a WhatsApp group. Renames the
   * contact when the subject changed. Single-flight per group so a burst of messages from a
   * new group never creates duplicate contacts. Returns { mapping, created }.
   */
  async resolveGroup({ locationId, sessionId, linkedNumber, groupJid, subject, inbound = true }) {
    const key = `${locationId}|${groupJid}`;
    // Chain synchronously behind any in-flight resolve for the same group (serialised per group).
    const running = this._groupInflight.get(key) || Promise.resolve();
    const p = running.catch(() => {}).then(() => this._resolveGroup({ locationId, sessionId, linkedNumber, groupJid, subject, inbound }));
    this._groupInflight.set(key, p);
    try {
      return await p;
    } finally {
      if (this._groupInflight.get(key) === p) this._groupInflight.delete(key);
    }
  }

  async _resolveGroup({ locationId, sessionId, linkedNumber, groupJid, subject, inbound }) {
    const cleanSubject = String(subject || '').trim();
    let mapping = await this.findGroup(locationId, groupJid);
    if (mapping) {
      const $set = { lastSessionId: sessionId, ...(inbound ? { lastInboundAt: new Date() } : {}) };
      if (cleanSubject && cleanSubject !== mapping.groupSubject) {
        $set.groupSubject = cleanSubject;
        $set.pushName = cleanSubject;
        try {
          await this.ghl.updateContact(locationId, mapping.ghlContactId, { firstName: groupDisplayName(cleanSubject), lastName: '' });
        } catch (err) {
          console.warn(`[Groups] rename contact ${mapping.ghlContactId} failed: ${err.message}`);
        }
      }
      await ContactMapping.updateOne({ _id: mapping._id }, { $set }).catch(() => {});
      return { mapping: Object.assign(mapping, $set), created: false };
    }

    // A pre-existing 1:1-style mapping on the group jid (shouldn't happen) is upgraded in place;
    // a contact-less placeholder (per-group flag set before first sync) gets its contact below.
    const stray = await ContactMapping.findOne({ locationId, waJid: groupJid });
    if (stray && stray.ghlContactId) {
      await ContactMapping.updateOne({ _id: stray._id }, { $set: { isGroup: true, groupSubject: cleanSubject, lastSessionId: sessionId } });
      return { mapping: Object.assign(stray, { isGroup: true, groupSubject: cleanSubject, lastSessionId: sessionId }), created: false };
    }

    const customFields = await this.ghl.customFieldValues(locationId, {
      whatsapp_id: groupJid,
      whatsapp_linked_number: linkedNumber,
      whatsapp_first_seen: new Date().toISOString(),
    });
    const contact = await this.ghl.createContact(locationId, {
      firstName: groupDisplayName(cleanSubject),
      lastName: '',
      tags: ['whatsapp-group'],
      ...(customFields.length ? { customFields } : {}),
    });
    if (stray) {
      const $set = {
        ghlContactId: contact.id,
        isGroup: true,
        groupSubject: cleanSubject || stray.groupSubject || '',
        pushName: cleanSubject || stray.pushName || '',
        lastSessionId: sessionId,
        ...(stray.firstSessionId ? {} : { firstSessionId: sessionId }),
        ...(inbound ? { lastInboundAt: new Date() } : {}),
      };
      const r = await ContactMapping.updateOne({ _id: stray._id, ghlContactId: null }, { $set });
      if (!r.modifiedCount) {
        // Another instance filled it first — keep theirs (our fresh contact is an orphan; rare).
        console.warn(`[Groups] placeholder ${groupJid} filled concurrently; orphan contact ${contact.id}`);
        mapping = await this.findGroup(locationId, groupJid);
        return { mapping, created: false };
      }
      return { mapping: Object.assign(stray, $set), created: true };
    }
    try {
      mapping = await ContactMapping.create({
        locationId,
        ghlContactId: contact.id,
        waJid: groupJid,
        isGroup: true,
        groupSubject: cleanSubject,
        pushName: cleanSubject,
        firstSessionId: sessionId,
        lastSessionId: sessionId,
        ...(inbound ? { lastInboundAt: new Date() } : {}),
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
      mapping = await this.findGroup(locationId, groupJid); // another instance won the race
    }
    return { mapping, created: true };
  }

  async touchOutbound(mappingId, sessionId) {
    await ContactMapping.updateOne({ _id: mappingId }, { $set: { lastSessionId: sessionId, lastOutboundAt: new Date() } }).catch(() => {});
  }

  async drop(mappingId) {
    await ContactMapping.deleteOne({ _id: mappingId });
  }
}

module.exports = ContactService;
module.exports.groupDisplayName = groupDisplayName;
