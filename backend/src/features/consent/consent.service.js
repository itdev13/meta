const axios = require('axios');
const ContactMapping = require('../../schemas/contact-mapping.schema');
const MessageLog = require('../../schemas/message-log.schema');
const { phoneToJid, isPnJid, isLidJid, jidToPhone, digits } = require('../../whatsapp/jid');
const { TRIGGERS } = require('../../workflows/trigger-keys');
const { ConsentSettings, ConsentContact, ConsentEvent, DEFAULTS } = require('./consent.schema');

const SETTINGS_TTL_MS = 30_000;
const DAY = 24 * 60 * 60 * 1000;
const MAX_KEYWORDS = 25;
const MAX_REPLY = 1000;

function codedError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

/** "Stop!" / " stop. " → "STOP". Whole-message match only, so "please stop calling" is not a keyword. */
function normalizeKeyword(text) {
  return String(text || '')
    .trim()
    .replace(/^[\s"'“”‘’*_~.!?¡¿]+|[\s"'“”‘’*_~.!?¡¿]+$/g, '')
    .toUpperCase();
}

function cleanKeywords(list, field) {
  if (!Array.isArray(list)) throw codedError(`${field} must be a list of words.`, 'INVALID');
  const out = [];
  for (const raw of list) {
    const k = normalizeKeyword(raw);
    if (!k) continue;
    if (k.length > 30) throw codedError(`Keyword “${k.slice(0, 30)}…” is too long (30 characters max).`, 'INVALID');
    if (!out.includes(k)) out.push(k);
  }
  if (out.length > MAX_KEYWORDS) throw codedError(`Up to ${MAX_KEYWORDS} keywords per list.`, 'INVALID');
  return out;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** CSV cell: quote, and neutralise spreadsheet formulas (keeps "+91…" phone numbers intact). */
function csvCell(v) {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=@\t\r]/.test(s) || /^[+-][^\d\s]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Consent & compliance (TCPA-style): per-location opt-in / opt-out state, keyword handling on
 * inbound messages, send blocking for opted-out contacts, and an append-only audit log.
 */
class ConsentService {
  constructor({ ghlService, workflowsService, messagingService }) {
    this.ghl = ghlService;
    this.workflows = workflowsService;
    this.messaging = messagingService;
    this._settings = new Map(); // locationId → { value, at }
  }

  // ── Settings ──────────────────────────────────────────────────

  async getSettings(locationId) {
    const hit = this._settings.get(locationId);
    if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
    const doc = await ConsentSettings.findOne({ locationId }).lean();
    const value = { ...DEFAULTS, ...(doc ? this._pickSettings(doc) : {}), locationId, saved: !!doc, updatedAt: doc?.updatedAt || null, updatedBy: doc?.updatedBy || '' };
    this._settings.set(locationId, { value, at: Date.now() });
    return value;
  }

  _pickSettings(doc) {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) if (doc[k] !== undefined && doc[k] !== null) out[k] = doc[k];
    return out;
  }

  async updateSettings(locationId, body = {}, auth = {}) {
    const $set = {};
    if (body.optOutKeywords !== undefined) $set.optOutKeywords = cleanKeywords(body.optOutKeywords, 'Opt-out keywords');
    if (body.optInKeywords !== undefined) $set.optInKeywords = cleanKeywords(body.optInKeywords, 'Opt-in keywords');
    for (const k of ['optOutReplyEnabled', 'optInReplyEnabled', 'implicitOptInOnInbound', 'enforce', 'tagOnOptOut']) {
      if (body[k] !== undefined) $set[k] = !!body[k];
    }
    for (const k of ['optOutReply', 'optInReply']) {
      if (body[k] === undefined) continue;
      const s = String(body[k] || '').trim();
      if (s.length > MAX_REPLY) throw codedError(`Confirmation messages are limited to ${MAX_REPLY} characters.`, 'INVALID');
      $set[k] = s;
    }
    if (body.optOutTag !== undefined) {
      const tag = String(body.optOutTag || '').trim().slice(0, 60);
      $set.optOutTag = tag;
    }

    const current = await this.getSettings(locationId);
    const next = { ...current, ...$set };
    if (!next.optOutKeywords.length) throw codedError('Keep at least one opt-out keyword (for example STOP).', 'INVALID');
    const overlap = next.optOutKeywords.filter((k) => next.optInKeywords.includes(k));
    if (overlap.length) throw codedError(`“${overlap[0]}” can’t be both an opt-out and an opt-in keyword.`, 'INVALID');
    if (next.optOutReplyEnabled && !next.optOutReply) throw codedError('Write the opt-out confirmation, or switch it off.', 'INVALID');
    if (next.optInReplyEnabled && !next.optInReply) throw codedError('Write the opt-in confirmation, or switch it off.', 'INVALID');
    if (next.tagOnOptOut && !next.optOutTag) throw codedError('Enter the tag to add on opt-out, or switch tagging off.', 'INVALID');

    $set.updatedBy = auth?.name || auth?.email || auth?.userId || '';
    await ConsentSettings.updateOne({ locationId }, { $set, $setOnInsert: { locationId } }, { upsert: true });
    this._settings.delete(locationId);
    return this.getSettings(locationId);
  }

  // ── Lookup ────────────────────────────────────────────────────

  _identityOr({ contactId, waJid, lidJid, phone }) {
    const or = [];
    if (contactId) or.push({ contactId });
    if (waJid) or.push({ waJid });
    if (lidJid) or.push({ lidJid });
    if (phone) or.push({ phone });
    return or;
  }

  async findRecord(locationId, ids) {
    const or = this._identityOr(ids);
    if (!or.length) return null;
    // Prefer the record carrying the contactId when several match (e.g. number blocked first, contact later).
    const rows = await ConsentContact.find({ locationId, $or: or }).sort({ contactId: -1, lastEventAt: -1 }).limit(3).lean();
    if (!rows.length) return null;
    return (ids.contactId && rows.find((r) => r.contactId === ids.contactId)) || rows[0];
  }

  /** Is this recipient opted out? One indexed query; returns the record or null. */
  async isOptedOut(locationId, ids) {
    const or = this._identityOr(ids);
    if (!or.length) return null;
    return ConsentContact.findOne({ locationId, status: 'opted_out', $or: or }).select('_id contactId phone').lean();
  }

  /** Fill phone / jid / name for a contact from the WhatsApp mapping, falling back to GHL. */
  async _identityFor(locationId, { contactId, phone }) {
    const out = { contactId: contactId || null, phone: '', waJid: null, lidJid: null, name: '' };
    if (contactId) {
      const m = await ContactMapping.findOne({ locationId, ghlContactId: contactId }).sort({ updatedAt: -1 }).lean();
      if (m) Object.assign(out, { phone: m.phone || '', waJid: m.waJid || null, lidJid: m.lidJid || null, name: m.pushName || '' });
      if (!out.phone || !out.name) {
        const c = await this.ghl.getContact(locationId, contactId);
        if (c) {
          out.phone = out.phone || c.phone || '';
          out.name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || c.name || out.name;
        }
      }
    }
    if (!out.phone && phone) out.phone = phone;
    if (out.phone && !out.waJid) {
      const jid = phoneToJid(out.phone);
      if (jid) {
        out.waJid = jid;
        out.phone = jidToPhone(jid);
      }
    }
    if (!out.contactId && out.waJid) {
      const m = await ContactMapping.findOne({ locationId, waJid: out.waJid }).lean();
      if (m) Object.assign(out, { contactId: m.ghlContactId, lidJid: out.lidJid || m.lidJid || null, name: out.name || m.pushName || '' });
    }
    return out;
  }

  // ── State changes ─────────────────────────────────────────────

  /**
   * Record a consent change. Always appends an event (repeat STOPs are part of the audit trail);
   * side-effects (tag, trigger, confirmation) run only when the status actually changed.
   * Returns { record, previousStatus, changed, event }, or null when `onlyIfStatus` is given and
   * the current status isn't in it (atomic — concurrent messages can't log the same change twice).
   */
  async record(locationId, { status, ids, method, keyword = '', text = '', note = '', actor = {}, session = null, workflowId = '', onlyIfStatus = null }) {
    const now = new Date();
    let existing = await this.findRecord(locationId, ids);
    const previousStatus = existing?.status || 'unknown';
    if (onlyIfStatus && !onlyIfStatus.includes(previousStatus)) return null;
    const guard = onlyIfStatus ? { status: { $in: onlyIfStatus } } : {};

    const $set = { status, lastMethod: method, lastEventAt: now };
    if (status === 'opted_in') $set.optedInAt = now;
    if (status === 'opted_out') $set.optedOutAt = now;
    if (session?.id) $set.sessionId = String(session.id);
    if (ids.contactId) $set.contactId = ids.contactId;
    if (ids.phone) $set.phone = ids.phone;
    if (ids.waJid) $set.waJid = ids.waJid;
    if (ids.lidJid) $set.lidJid = ids.lidJid;
    if (ids.name) $set.name = ids.name;

    let record;
    if (existing) {
      record = await ConsentContact.findOneAndUpdate({ _id: existing._id, ...guard }, { $set }, { new: true }).lean();
    } else {
      try {
        record = (await ConsentContact.create({ locationId, ...$set })).toObject();
      } catch (err) {
        if (err.code !== 11000) throw err;
        existing = await this.findRecord(locationId, ids); // lost a race — update the winner
        if (!existing) throw err;
        record = await ConsentContact.findOneAndUpdate({ _id: existing._id, ...guard }, { $set }, { new: true }).lean();
      }
    }
    if (!record) return null;

    const event = await ConsentEvent.create({
      locationId,
      consentContactId: record._id,
      contactId: record.contactId,
      phone: record.phone,
      waJid: record.waJid || record.lidJid || '',
      contactName: record.name,
      event: status,
      previousStatus,
      method,
      keyword,
      text: String(text || '').slice(0, 500),
      note: String(note || '').slice(0, 500),
      actor,
      sessionId: session?.id ? String(session.id) : '',
      linkedNumber: session?.phoneNumber || '',
      workflowId,
    });

    const changed = previousStatus !== status;
    if (changed) this._sideEffects(locationId, record, { status, previousStatus, method, keyword, text, session, at: now }).catch(() => {});
    return { record, previousStatus, changed, event };
  }

  /** Tag + workflow trigger. Best-effort, never throws into the caller. */
  async _sideEffects(locationId, record, { status, previousStatus, method, keyword, text, session, at }) {
    const settings = await this.getSettings(locationId);
    if (record.contactId && settings.tagOnOptOut && settings.optOutTag) {
      if (status === 'opted_out') await this.ghl.addTags(locationId, record.contactId, [settings.optOutTag]);
      else if (previousStatus === 'opted_out') await this._removeTag(locationId, record.contactId, settings.optOutTag);
    }
    // Implicit opt-ins (first inbound message) are logged but don't fire the trigger — that would
    // fire for every new conversation. Explicit opt-ins and every opt-out do.
    if (status === 'opted_in' && method === 'inbound_message') return;
    await this.workflows.fireTrigger(status === 'opted_out' ? TRIGGERS.CONTACT_OPTED_OUT : TRIGGERS.CONTACT_OPTED_IN, locationId, {
      locationId,
      contactId: record.contactId || '',
      phone: record.phone || '',
      contactName: record.name || '',
      whatsappId: record.waJid || record.lidJid || '',
      status,
      previousStatus,
      method,
      keyword: keyword || '',
      messageText: String(text || '').slice(0, 500),
      linkedNumber: session?.phoneNumber || '',
      linkedNumberLabel: session?.label || '',
      timestamp: at.toISOString(),
    });
  }

  async _removeTag(locationId, contactId, tag) {
    try {
      if (typeof this.ghl.removeTags === 'function') {
        await this.ghl.removeTags(locationId, contactId, [tag]);
        return;
      }
      await this.ghl._apiRequest(locationId, (t) =>
        axios.delete(`${this.ghl.apiBase}/contacts/${contactId}/tags`, { headers: this.ghl._headers(t), data: { tags: [tag] } }),
      );
    } catch (err) {
      console.warn(`[consent] remove tag failed for ${contactId}: ${err.message}`);
    }
  }

  _confirm(locationId, contactId, text, session) {
    if (!contactId || !text) return;
    this.messaging
      .send({ locationId, contactId, text, source: 'auto', bypassConsent: true, mirror: true, meta: { feature: 'consent' } })
      .catch((err) => console.warn(`[consent] confirmation to ${contactId} via ${session?.id || '?'} failed: ${err.code || ''} ${err.message}`));
  }

  // ── Hooks ─────────────────────────────────────────────────────

  /** afterInbound: keywords + implicit opt-in. Runs before rules; sets ctx.handled on a keyword. */
  async onInbound(ctx) {
    if (ctx.fromMe || ctx.isGroup || ctx.handled) return;
    const locationId = ctx.session?.locationId;
    if (!locationId || !ctx.contactId) return;

    const settings = await this.getSettings(locationId);
    const word = normalizeKeyword(ctx.info?.kind === 'text' || !ctx.info ? ctx.text : '');
    const m = ctx.mapping || {};
    const ids = {
      contactId: ctx.contactId,
      waJid: m.waJid || (isPnJid(ctx.triggerPayload?.whatsappId) ? ctx.triggerPayload.whatsappId : null),
      lidJid: m.lidJid || (isLidJid(ctx.triggerPayload?.whatsappId) ? ctx.triggerPayload.whatsappId : null),
      phone: m.phone || ctx.triggerPayload?.phone || '',
      name: ctx.triggerPayload?.contactName || m.pushName || '',
    };
    const session = { id: ctx.session.id, phoneNumber: ctx.sessionDoc?.phoneNumber || '', label: ctx.sessionDoc?.label || '' };
    const actor = { type: 'contact', id: ctx.contactId, name: ids.name };

    if (word && settings.optOutKeywords.includes(word)) {
      ctx.handled = true;
      ctx.consent = { event: 'opted_out', keyword: word };
      const r = await this.record(locationId, { status: 'opted_out', ids, method: 'keyword', keyword: word, text: ctx.text, actor, session });
      if (r.changed && settings.optOutReplyEnabled) this._confirm(locationId, ctx.contactId, settings.optOutReply, session);
      return;
    }

    const existing = await this.findRecord(locationId, ids);
    const status = existing?.status || 'unknown';

    if (word && settings.optInKeywords.includes(word) && status !== 'opted_in') {
      // "YES" is also an everyday answer. From an unknown contact it opts them in but the message
      // still flows to rules/agents; only a resubscribe (was opted out) is consumed + confirmed.
      const resubscribe = status === 'opted_out';
      if (resubscribe) {
        ctx.handled = true;
        ctx.consent = { event: 'opted_in', keyword: word };
      }
      const r = await this.record(locationId, { status: 'opted_in', ids, method: 'keyword', keyword: word, text: ctx.text, actor, session });
      if (resubscribe && r.changed && settings.optInReplyEnabled) this._confirm(locationId, ctx.contactId, settings.optInReply, session);
      return;
    }

    if (settings.implicitOptInOnInbound && status === 'unknown') {
      // Guarded on 'unknown' so a burst of first messages logs the implicit opt-in exactly once.
      await this.record(locationId, { status: 'opted_in', ids, method: 'inbound_message', text: ctx.text, actor, session, onlyIfStatus: ['unknown'] });
    }
  }

  /** beforeSend: block opted-out contacts unless the caller bypasses (e.g. the STOP confirmation). */
  async onBeforeSend(ctx) {
    // Group sends (features/groups) are not one-to-one marketing to a contact: never checked.
    if (ctx.bypassConsent || ctx.meta?.isGroup || !ctx.locationId) return;
    const settings = await this.getSettings(ctx.locationId);
    if (!settings.enforce) return;
    const jid = ctx.jid || null;
    const ids = {
      contactId: ctx.contactId || null,
      waJid: (isPnJid(jid) && jid) || ctx.mapping?.waJid || null,
      lidJid: (isLidJid(jid) && jid) || ctx.mapping?.lidJid || null,
      phone: isPnJid(jid) ? jidToPhone(jid) : ctx.mapping?.phone || (ctx.phone ? jidToPhone(phoneToJid(ctx.phone)) : ''),
    };
    const hit = await this.isOptedOut(ctx.locationId, ids);
    if (hit) throw codedError('This contact unsubscribed from WhatsApp messages.', 'OPTED_OUT', 409);
  }

  // ── Manual / workflow ─────────────────────────────────────────

  async manualChange(locationId, { contactId, phone, status, note }, auth = {}) {
    if (!['opted_in', 'opted_out'].includes(status)) throw codedError('Choose opt in or opt out.', 'INVALID');
    const reason = String(note || '').trim();
    if (reason.length < 3) throw codedError('Add a short reason — it’s stored in the consent log.', 'NOTE_REQUIRED');
    if (!contactId && !phone) throw codedError('Pick a contact or enter a phone number.', 'INVALID');
    if (!contactId && !digits(phone)) throw codedError('Enter a valid phone number.', 'INVALID');
    const ids = await this._identityFor(locationId, { contactId, phone });
    if (!ids.contactId && !ids.waJid) throw codedError('Enter a valid phone number.', 'INVALID');
    const r = await this.record(locationId, {
      status,
      ids,
      method: 'manual',
      note: reason,
      actor: { type: 'user', id: auth?.userId || '', name: auth?.name || '', email: auth?.email || '' },
    });
    return { contact: r.record, changed: r.changed, previousStatus: r.previousStatus };
  }

  async workflowChange(payload, status) {
    const extras = payload?.extras || {};
    const data = payload?.data || payload?.inputData || {};
    const { locationId, contactId } = extras;
    if (!locationId) throw codedError('Missing locationId', 'INVALID');
    const phone = String(data.phone || data.phoneNumber || '').trim();
    if (!contactId && !phone) throw codedError('This action needs a contact', 'NO_PHONE');
    const ids = await this._identityFor(locationId, { contactId, phone });
    const r = await this.record(locationId, {
      status,
      ids,
      method: 'workflow',
      note: String(data.note || data.reason || '').slice(0, 500) || 'Changed by a workflow',
      actor: { type: 'workflow', id: extras.workflowId || '', name: payload?.meta?.workflowName || 'Workflow' },
      workflowId: extras.workflowId || '',
    });
    return { status: r.record.status, previousStatus: r.previousStatus, changed: r.changed ? 'yes' : 'no' };
  }

  // ── Reads ─────────────────────────────────────────────────────

  async listContacts(locationId, { status, q, page = 1, limit = 25 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const pg = Math.max(Number(page) || 1, 1);
    const filter = { locationId };
    if (['opted_in', 'opted_out', 'unknown'].includes(status)) filter.status = status;
    const term = String(q || '').trim().slice(0, 80);
    if (term) {
      const or = [{ name: { $regex: escapeRe(term), $options: 'i' } }];
      const d = digits(term);
      if (d.length >= 3) or.push({ phone: { $regex: escapeRe(d) } });
      if (/^[A-Za-z0-9]{12,}$/.test(term)) or.push({ contactId: term });
      filter.$or = or;
    }
    const [items, total] = await Promise.all([
      ConsentContact.find(filter).sort({ lastEventAt: -1, _id: -1 }).skip((pg - 1) * lim).limit(lim).lean(),
      ConsentContact.countDocuments(filter),
    ]);
    return { items, total, page: pg, limit: lim, pages: Math.max(1, Math.ceil(total / lim)) };
  }

  async contactLog(locationId, id) {
    const or = [{ contactId: id }];
    if (/^[a-f\d]{24}$/i.test(id)) or.push({ _id: id });
    const contact = await ConsentContact.findOne({ locationId, $or: or }).lean();
    if (!contact) throw codedError('No consent record for this contact yet.', 'NOT_FOUND', 404);
    const events = await ConsentEvent.find({ locationId, consentContactId: contact._id }).sort({ createdAt: -1 }).limit(500).lean();
    return { contact, events };
  }

  async stats(locationId) {
    const since = new Date(Date.now() - 30 * DAY);
    const [byStatus, recent, reached] = await Promise.all([
      ConsentContact.aggregate([{ $match: { locationId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      ConsentEvent.aggregate([
        { $match: { locationId, createdAt: { $gte: since } } },
        { $match: { $expr: { $ne: ['$event', '$previousStatus'] } } },
        {
          $group: {
            _id: { event: '$event', day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } },
            n: { $sum: 1 },
            contacts: { $addToSet: '$consentContactId' },
          },
        },
      ]),
      MessageLog.distinct('ghlContactId', { locationId, direction: 'outbound', createdAt: { $gte: since }, ghlContactId: { $type: 'string' } }),
    ]);
    const counts = { opted_in: 0, opted_out: 0, unknown: 0 };
    for (const r of byStatus) counts[r._id] = r.n;

    const days = [];
    for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * DAY).toISOString().slice(0, 10));
    const series = Object.fromEntries(days.map((d) => [d, { date: d, optOuts: 0, optIns: 0 }]));
    const outSet = new Set();
    const inSet = new Set();
    for (const r of recent) {
      const row = series[r._id.day];
      if (r._id.event === 'opted_out') {
        if (row) row.optOuts += r.n;
        r.contacts.forEach((c) => outSet.add(String(c)));
      } else {
        if (row) row.optIns += r.n;
        r.contacts.forEach((c) => inSet.add(String(c)));
      }
    }
    const optOuts30d = outSet.size;
    const reached30d = reached.length;
    return {
      counts,
      total: counts.opted_in + counts.opted_out + counts.unknown,
      optOuts30d,
      optIns30d: inSet.size,
      reached30d,
      // Unsubscribes ÷ contacts we messaged in the window (null when nothing was sent).
      optOutRate30d: reached30d ? optOuts30d / reached30d : null,
      series: days.map((d) => series[d]),
    };
  }

  /** Full audit log as CSV, streamed from a cursor. */
  async exportCsv(locationId, res) {
    const cols = ['timestamp', 'event', 'previous_status', 'contact_id', 'contact_name', 'phone', 'whatsapp_id', 'channel', 'method', 'keyword', 'message_text', 'note', 'actor_type', 'actor_name', 'actor_email', 'linked_number', 'session_id', 'workflow_id'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="whatsapp-consent-log-${locationId}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.write(`﻿${cols.join(',')}\n`);
    const cursor = ConsentEvent.find({ locationId }).sort({ createdAt: 1 }).lean().cursor();
    for await (const e of cursor) {
      const row = [
        e.createdAt, e.event, e.previousStatus, e.contactId, e.contactName, e.phone, e.waJid, e.channel, e.method, e.keyword, e.text, e.note,
        e.actor?.type, e.actor?.name, e.actor?.email, e.linkedNumber, e.sessionId, e.workflowId,
      ];
      if (!res.write(`${row.map(csvCell).join(',')}\n`)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  }
}

module.exports = { ConsentService, normalizeKeyword, csvCell };
