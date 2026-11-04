const mongoose = require('mongoose');
const MessageLog = require('../../schemas/message-log.schema');
const { TRIGGERS } = require('../../workflows/trigger-keys');
const { Template, Rule, Settings, Cooldown, Hit, DEFAULT_SCHEDULE } = require('./models');
const { TemplateService, validTimezone } = require('./template.service');
const { firstMatch, isOpen, normalize } = require('./matcher');

const RULES_TTL = 15_000;
const MAX_RULES = 100;
const MAX_TEMPLATES = 200;
const DAY = 24 * 60 * 60 * 1000;

function bad(message, code = 'INVALID', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}
const isId = (id) => mongoose.isValidObjectId(id);
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const uniqStrings = (arr, max, len) =>
  [...new Set((Array.isArray(arr) ? arr : String(arr || '').split(',')).map((x) => clean(x, len)).filter(Boolean))].slice(0, max);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

function toTemplate(t) {
  return {
    id: String(t._id),
    name: t.name,
    body: t.body,
    mediaUrl: t.mediaUrl || '',
    category: t.category || 'general',
    usageCount: t.usageCount || 0,
    lastUsedAt: t.lastUsedAt || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function toRule(r) {
  return {
    id: String(r._id),
    name: r.name,
    enabled: r.enabled !== false,
    priority: r.priority ?? 0,
    matchType: r.matchType || 'exact',
    keywords: r.keywords || [],
    sessionIds: r.sessionIds || [],
    reply: { mode: r.reply?.mode || 'none', text: r.reply?.text || '', templateId: r.reply?.templateId || '' },
    tags: r.tags || [],
    fireTrigger: r.fireTrigger !== false,
    cooldownMinutes: r.cooldownMinutes ?? 60,
    hitCount: r.hitCount || 0,
    lastTriggeredAt: r.lastTriggeredAt || null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toSettings(doc, locationTimezone = '', businessName = '') {
  const a = doc?.away || {};
  const w = doc?.welcome || {};
  return {
    away: {
      enabled: !!a.enabled,
      timezone: a.timezone || '',
      schedule: Array.isArray(a.schedule) && a.schedule.length === 7 ? a.schedule.map((d) => ({ open: !!d.open, start: d.start, end: d.end })) : DEFAULT_SCHEDULE,
      message: a.message || '',
      templateId: a.templateId || '',
      cooldownHours: a.cooldownHours ?? 12,
      sessionIds: a.sessionIds || [],
    },
    welcome: { enabled: !!w.enabled, message: w.message || '', templateId: w.templateId || '', sessionIds: w.sessionIds || [] },
    locationTimezone,
    businessName,
  };
}

/**
 * Templates, keyword rules, away + welcome auto-replies. CRUD for the API, plus the inbound
 * engine (afterInbound) and the template renderer used by beforeSend + the workflow action.
 */
class RulesService {
  constructor(services) {
    this.s = services;
    this.ghl = services.ghlService;
    this.messaging = services.messagingService;
    this.workflows = services.workflowsService;
    this.templates = new TemplateService(services.ghlService);
    this._rulesCache = new Map(); // locationId → { at, rules }
  }

  // ── Templates ────────────────────────────────────────────────

  async listTemplates(locationId) {
    const rows = await Template.find({ locationId }).sort({ category: 1, name: 1 }).lean();
    return rows.map(toTemplate);
  }

  _templateInput(body = {}, partial = false) {
    const out = {};
    if (!partial || body.name !== undefined) {
      out.name = clean(body.name, 80);
      if (!out.name) throw bad('Give the template a name.');
      out.nameKey = out.name.toLowerCase();
    }
    if (!partial || body.body !== undefined) out.body = String(body.body ?? '').slice(0, 4096);
    if (!partial || body.mediaUrl !== undefined) {
      out.mediaUrl = clean(body.mediaUrl, 2000);
      if (out.mediaUrl && !/^https?:\/\//i.test(out.mediaUrl)) throw bad('Media URL must start with http:// or https://');
    }
    if (!partial || body.category !== undefined) out.category = clean(body.category, 40).toLowerCase() || 'general';
    return out;
  }

  async createTemplate(auth, locationId, body) {
    const input = this._templateInput(body);
    if (!input.body.trim() && !input.mediaUrl) throw bad('A template needs a message or a media URL.', 'EMPTY');
    if ((await Template.countDocuments({ locationId })) >= MAX_TEMPLATES) throw bad(`You can save up to ${MAX_TEMPLATES} templates.`, 'LIMIT');
    try {
      const doc = await Template.create({ ...input, locationId, createdBy: { userId: auth?.userId, name: auth?.userName || auth?.name } });
      return toTemplate(doc);
    } catch (err) {
      if (err.code === 11000) throw bad(`A template called “${input.name}” already exists.`, 'DUPLICATE', 409);
      throw err;
    }
  }

  async updateTemplate(locationId, id, body) {
    if (!isId(id)) throw bad('Template not found', 'NOT_FOUND', 404);
    const input = this._templateInput(body, true);
    try {
      const doc = await Template.findOneAndUpdate({ _id: id, locationId }, { $set: input }, { new: true });
      if (!doc) throw bad('Template not found', 'NOT_FOUND', 404);
      if (!doc.body.trim() && !doc.mediaUrl) throw bad('A template needs a message or a media URL.', 'EMPTY');
      return toTemplate(doc);
    } catch (err) {
      if (err.code === 11000) throw bad(`A template called “${input.name}” already exists.`, 'DUPLICATE', 409);
      throw err;
    }
  }

  async deleteTemplate(locationId, id) {
    if (!isId(id)) throw bad('Template not found', 'NOT_FOUND', 404);
    const usedBy = await Rule.find({ locationId, 'reply.mode': 'template', 'reply.templateId': id }).select('name').lean();
    const settings = await Settings.findOne({ locationId }).lean();
    const users = usedBy.map((r) => `rule “${r.name}”`);
    if (settings?.away?.templateId === id) users.push('the away message');
    if (settings?.welcome?.templateId === id) users.push('the welcome message');
    if (users.length) throw bad(`This template is used by ${users.join(', ')}. Change those first.`, 'IN_USE', 409);
    const r = await Template.deleteOne({ _id: id, locationId });
    if (!r.deletedCount) throw bad('Template not found', 'NOT_FOUND', 404);
    return { deleted: true };
  }

  async findTemplate(locationId, { templateId, templateName } = {}) {
    if (templateId && isId(templateId)) {
      const t = await Template.findOne({ _id: templateId, locationId }).lean();
      if (t) return t;
    }
    const name = clean(templateName || (!isId(templateId) ? templateId : ''), 80).toLowerCase();
    if (name) return Template.findOne({ locationId, nameKey: name }).lean();
    return null;
  }

  /** POST /templates/preview — { templateId? | body?, mediaUrl?, contactId? } */
  async preview(locationId, body = {}) {
    let text = body.body;
    let mediaUrl = body.mediaUrl || '';
    let name = '';
    if (text === undefined && (body.templateId || body.templateName)) {
      const t = await this.findTemplate(locationId, body);
      if (!t) throw bad('Template not found', 'NOT_FOUND', 404);
      text = t.body;
      mediaUrl = t.mediaUrl;
      name = t.name;
    }
    const contactId = clean(body.contactId, 64);
    let contact = null;
    if (contactId) {
      contact = await this.ghl.getContact(locationId, contactId);
      if (!contact) throw bad('Contact not found in this sub-account.', 'NOT_FOUND', 404);
    }
    const r = await this.templates.renderDetailed(locationId, String(text ?? ''), contact ? { contact } : { sample: true });
    const loc = await this.templates.location(locationId);
    return {
      name,
      text: r.text,
      missing: r.missing,
      mediaUrl,
      usingSample: !contact,
      contact: contact ? { id: contact.id, name: contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' '), phone: contact.phone || '' } : null,
      businessName: loc.name || '',
    };
  }

  // ── Rules ────────────────────────────────────────────────────

  _invalidate(locationId) {
    this._rulesCache.delete(locationId);
  }

  async _activeRules(locationId) {
    const hit = this._rulesCache.get(locationId);
    if (hit && Date.now() - hit.at < RULES_TTL) return hit.rules;
    const rules = await Rule.find({ locationId, enabled: true }).sort({ priority: 1, createdAt: 1 }).lean();
    this._rulesCache.set(locationId, { at: Date.now(), rules });
    return rules;
  }

  async listRules(locationId) {
    const rows = await Rule.find({ locationId }).sort({ priority: 1, createdAt: 1 }).lean();
    return rows.map(toRule);
  }

  async _ruleInput(locationId, body = {}, partial = false) {
    const out = {};
    const has = (k) => !partial || body[k] !== undefined;
    if (has('name')) {
      out.name = clean(body.name, 80);
      if (!out.name) throw bad('Give the rule a name.');
    }
    if (has('enabled')) out.enabled = body.enabled !== false;
    if (has('matchType')) {
      out.matchType = ['exact', 'contains', 'starts_with'].includes(body.matchType) ? body.matchType : 'exact';
    }
    if (has('keywords')) {
      out.keywords = [...new Set(uniqStrings(body.keywords, 30, 100).map(normalize).filter(Boolean))];
      if (!out.keywords.length) throw bad('Add at least one keyword.');
    }
    if (has('sessionIds')) out.sessionIds = uniqStrings(body.sessionIds, 50, 64).filter(isId);
    if (has('reply')) {
      const r = body.reply || {};
      const mode = ['none', 'text', 'template'].includes(r.mode) ? r.mode : 'none';
      out.reply = { mode, text: mode === 'text' ? String(r.text ?? '').slice(0, 4096) : '', templateId: mode === 'template' ? clean(r.templateId, 64) : '' };
      if (mode === 'text' && !out.reply.text.trim()) throw bad('Write the reply text, or choose “No reply”.');
      if (mode === 'template') {
        if (!isId(out.reply.templateId) || !(await Template.exists({ _id: out.reply.templateId, locationId }))) throw bad('Choose a template for the reply.');
      }
    }
    if (has('tags')) out.tags = uniqStrings(body.tags, 20, 60);
    if (has('fireTrigger')) out.fireTrigger = body.fireTrigger !== false;
    if (has('cooldownMinutes')) {
      const n = Number(body.cooldownMinutes);
      out.cooldownMinutes = Number.isFinite(n) ? Math.max(0, Math.min(60 * 24 * 30, Math.round(n))) : 60;
    }
    return out;
  }

  async createRule(locationId, body) {
    if ((await Rule.countDocuments({ locationId })) >= MAX_RULES) throw bad(`You can have up to ${MAX_RULES} rules.`, 'LIMIT');
    const input = await this._ruleInput(locationId, body);
    const last = await Rule.findOne({ locationId }).sort({ priority: -1 }).select('priority').lean();
    const doc = await Rule.create({ ...input, locationId, priority: (last?.priority ?? -1) + 1 });
    this._invalidate(locationId);
    return toRule(doc);
  }

  async updateRule(locationId, id, body) {
    if (!isId(id)) throw bad('Rule not found', 'NOT_FOUND', 404);
    const input = await this._ruleInput(locationId, body, true);
    const doc = await Rule.findOneAndUpdate({ _id: id, locationId }, { $set: input }, { new: true });
    if (!doc) throw bad('Rule not found', 'NOT_FOUND', 404);
    this._invalidate(locationId);
    return toRule(doc);
  }

  async deleteRule(locationId, id) {
    if (!isId(id)) throw bad('Rule not found', 'NOT_FOUND', 404);
    const r = await Rule.deleteOne({ _id: id, locationId });
    if (!r.deletedCount) throw bad('Rule not found', 'NOT_FOUND', 404);
    this._invalidate(locationId);
    await Cooldown.deleteMany({ locationId, key: `rule:${id}` }).catch(() => {});
    return { deleted: true };
  }

  /** ids in the new order (first = highest priority). Unlisted rules keep their relative order after. */
  async reorder(locationId, ids) {
    const list = (Array.isArray(ids) ? ids : []).map(String).filter(isId);
    const all = await Rule.find({ locationId }).sort({ priority: 1, createdAt: 1 }).select('_id').lean();
    const known = new Set(all.map((r) => String(r._id)));
    const ordered = [...new Set(list.filter((id) => known.has(id)))];
    for (const r of all) if (!ordered.includes(String(r._id))) ordered.push(String(r._id));
    if (ordered.length) {
      await Rule.bulkWrite(ordered.map((id, i) => ({ updateOne: { filter: { _id: id, locationId }, update: { $set: { priority: i } } } })));
    }
    this._invalidate(locationId);
    return this.listRules(locationId);
  }

  /** Which enabled rule would fire for this text (server-side twin of the UI tester). */
  async test(locationId, { text, sessionId } = {}) {
    const rules = await this._activeRules(locationId);
    const m = firstMatch(rules, text, sessionId || null);
    return m ? { matched: true, rule: toRule(m.rule), keyword: m.keyword } : { matched: false };
  }

  // ── Settings ─────────────────────────────────────────────────

  async getSettings(locationId) {
    const [doc, loc] = await Promise.all([Settings.findOne({ locationId }).lean(), this.templates.location(locationId)]);
    return toSettings(doc, validTimezone(loc.timezone) ? loc.timezone : '', loc.name || '');
  }

  async _checkTemplate(locationId, templateId) {
    if (!templateId) return '';
    if (!isId(templateId) || !(await Template.exists({ _id: templateId, locationId }))) throw bad('That template no longer exists.');
    return templateId;
  }

  async saveAway(locationId, input = {}) {
    // Merge: fields the caller omits keep their stored value (PUT with a partial body is safe).
    const current = (await this.getSettings(locationId)).away || {};
    const body = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    const tz = clean(body.timezone, 64);
    if (tz && !validTimezone(tz)) throw bad('Unknown timezone.');
    let schedule;
    if (body.schedule !== undefined) {
      if (!Array.isArray(body.schedule) || body.schedule.length !== 7) throw bad('The schedule needs all 7 days.');
      schedule = body.schedule.map((d, i) => {
        const start = String(d?.start || '09:00');
        const end = String(d?.end || '17:00');
        if (!HHMM.test(start) || !HHMM.test(end)) throw bad(`Day ${i + 1}: times must be HH:MM.`);
        return { open: !!d?.open, start, end };
      });
    }
    const templateId = await this._checkTemplate(locationId, clean(body.templateId, 64));
    const message = String(body.message ?? '').slice(0, 4096);
    const enabled = !!body.enabled;
    if (enabled && !message.trim() && !templateId) throw bad('Write the away message (or pick a template) before turning it on.', 'EMPTY');
    const ch = Number(body.cooldownHours);
    const $set = {
      'away.enabled': enabled,
      'away.timezone': tz,
      'away.message': message,
      'away.templateId': templateId,
      'away.cooldownHours': Number.isFinite(ch) ? Math.max(0, Math.min(24 * 30, ch)) : 12,
      'away.sessionIds': uniqStrings(body.sessionIds, 50, 64).filter(isId),
      ...(schedule ? { 'away.schedule': schedule } : {}),
    };
    await Settings.updateOne({ locationId }, { $set, $setOnInsert: { locationId } }, { upsert: true });
    return (await this.getSettings(locationId)).away;
  }

  async saveWelcome(locationId, input = {}) {
    const current = (await this.getSettings(locationId)).welcome || {};
    const body = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    const templateId = await this._checkTemplate(locationId, clean(body.templateId, 64));
    const message = String(body.message ?? '').slice(0, 4096);
    const enabled = !!body.enabled;
    if (enabled && !message.trim() && !templateId) throw bad('Write the welcome message (or pick a template) before turning it on.', 'EMPTY');
    await Settings.updateOne(
      { locationId },
      {
        $set: { 'welcome.enabled': enabled, 'welcome.message': message, 'welcome.templateId': templateId, 'welcome.sessionIds': uniqStrings(body.sessionIds, 50, 64).filter(isId) },
        $setOnInsert: { locationId },
      },
      { upsert: true },
    );
    return (await this.getSettings(locationId)).welcome;
  }

  /** Is the business open now? → { open, timezone, enabled } (for the UI badge). */
  async hoursStatus(locationId) {
    const s = await this.getSettings(locationId);
    const tz = await this.templates.timezone(locationId, s.away.timezone);
    return { enabled: s.away.enabled, open: isOpen(s.away.schedule, tz), timezone: tz };
  }

  // ── Stats ────────────────────────────────────────────────────

  async stats(locationId) {
    const since = new Date(Date.now() - 30 * DAY);
    const [byRule, byKind, daily, rules] = await Promise.all([
      Hit.aggregate([{ $match: { locationId, kind: 'rule', at: { $gte: since } } }, { $group: { _id: '$ruleId', hits: { $sum: 1 }, replied: { $sum: { $cond: ['$replied', 1, 0] } }, contacts: { $addToSet: '$contactId' } } }]),
      Hit.aggregate([{ $match: { locationId, at: { $gte: since } } }, { $group: { _id: '$kind', n: { $sum: 1 } } }]),
      Hit.aggregate([
        { $match: { locationId, at: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$at' } }, n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Rule.find({ locationId }).select('name hitCount lastTriggeredAt').lean(),
    ]);
    const map = Object.fromEntries(byRule.map((r) => [r._id, r]));
    const kinds = Object.fromEntries(byKind.map((k) => [k._id, k.n]));
    return {
      since,
      totals: { rules: kinds.rule || 0, away: kinds.away || 0, welcome: kinds.welcome || 0 },
      rules: rules.map((r) => {
        const s = map[String(r._id)];
        return { ruleId: String(r._id), name: r.name, hits30d: s?.hits || 0, replied30d: s?.replied || 0, contacts30d: s?.contacts?.length || 0, hitCount: r.hitCount || 0, lastTriggeredAt: r.lastTriggeredAt || null };
      }),
      daily: daily.map((d) => ({ date: d._id, n: d.n })),
    };
  }

  // ── Engine ───────────────────────────────────────────────────

  /**
   * Atomically claim a per-contact cooldown slot. true = we may send now (and the slot is now
   * taken), false = still cooling down. Concurrent inbounds for the same contact can't both win:
   * the upsert collides on the unique index when the existing row is still inside the window.
   */
  async _claim(locationId, contactId, key, windowMs) {
    if (!contactId) return true;
    const now = new Date();
    const cutoff = new Date(now.getTime() - Math.max(0, windowMs));
    try {
      await Cooldown.findOneAndUpdate(
        { locationId, contactId, key, lastAt: { $lte: cutoff } },
        { $set: { lastAt: now, expiresAt: new Date(now.getTime() + Math.max(windowMs, DAY) + DAY) } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      if (err.code === 11000) return false;
      throw err;
    }
  }

  async _release(locationId, contactId, key) {
    await Cooldown.deleteOne({ locationId, contactId, key }).catch(() => {});
  }

  /** Resolve a reply source ({ templateId } or { text }) into { text, attachments, template }. */
  async _content(locationId, { templateId, text }, contactId) {
    let body = text || '';
    let attachments = [];
    let template = null;
    if (templateId) {
      template = await this.findTemplate(locationId, { templateId });
      if (!template) return null;
      body = template.body || '';
      if (template.mediaUrl) attachments = [template.mediaUrl];
    }
    const rendered = await this.templates.render(locationId, body, { contactId });
    if (!rendered.trim() && !attachments.length) return null;
    return { text: rendered.trim() ? rendered : '', attachments, template };
  }

  async _sendAuto(ctx, content, meta) {
    const r = await this.messaging.send({
      locationId: ctx.session.locationId,
      contactId: ctx.contactId,
      text: content.text,
      attachments: content.attachments,
      source: 'auto',
      preferredSessionId: ctx.session.id,
      mirror: true,
      meta: { feature: 'rules', rendered: true, ...meta },
    });
    if (content.template) {
      Template.updateOne({ _id: content.template._id }, { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }).catch(() => {});
    }
    return r;
  }

  _scoped(sessionIds, sessionId) {
    return !sessionIds?.length || sessionIds.map(String).includes(String(sessionId));
  }

  /** afterInbound hook. Order: keyword rule → welcome (new contact) → away (outside hours, no rule reply). */
  async onInbound(ctx) {
    if (ctx.handled || ctx.fromMe || ctx.isGroup) return;
    const locationId = ctx.session?.locationId;
    const contactId = ctx.contactId;
    if (!locationId || !contactId) return;
    const text = ctx.text || ctx.info?.text || '';
    const tag = `[rules] ${locationId}/${contactId}`;

    let ruleReplied = false;

    // 1. Keyword rule (first match wins)
    if (text.trim()) {
      const rules = await this._activeRules(locationId);
      const m = firstMatch(rules, text, ctx.session.id);
      if (m) {
        const { rule, keyword } = m;
        const ruleId = String(rule._id);
        if (ctx.msg?.key?.id) {
          MessageLog.updateOne({ sessionId: ctx.session.id, waMessageId: ctx.msg.key.id }, { $set: { keyword } }).catch(() => {});
        }
        const key = `rule:${ruleId}`;
        const allowed = await this._claim(locationId, contactId, key, (rule.cooldownMinutes ?? 60) * 60 * 1000);
        if (!allowed) {
          console.log(`${tag} rule “${rule.name}” matched “${keyword}” but is cooling down`);
        } else {
          ctx.ruleMatched = { ruleId, keyword };
          Rule.updateOne({ _id: rule._id }, { $inc: { hitCount: 1 }, $set: { lastTriggeredAt: new Date() } }).catch(() => {});

          if (rule.tags?.length) await this.ghl.addTags(locationId, contactId, rule.tags);

          if (rule.reply?.mode === 'text' || rule.reply?.mode === 'template') {
            try {
              const content = await this._content(locationId, rule.reply.mode === 'template' ? { templateId: rule.reply.templateId } : { text: rule.reply.text }, contactId);
              if (content) {
                await this._sendAuto(ctx, content, { ruleId, keyword });
                ruleReplied = true;
              } else {
                console.warn(`${tag} rule “${rule.name}”: reply is empty or its template was deleted`);
              }
            } catch (err) {
              console.warn(`${tag} rule “${rule.name}” reply failed: ${err.code || ''} ${err.message}`);
            }
          }

          if (rule.fireTrigger !== false) {
            const base = ctx.triggerPayload || {};
            this.workflows
              .fireTrigger(TRIGGERS.KEYWORD_RECEIVED, locationId, {
                ...base,
                keyword,
                ruleName: rule.name,
                ruleId,
                matchType: rule.matchType,
                messageText: text,
                contactId,
                phone: base.phone || ctx.mapping?.phone || '',
                linkedNumber: base.linkedNumber || ctx.sessionDoc?.phoneNumber || '',
                timestamp: base.timestamp || new Date().toISOString(),
              })
              .catch(() => {});
          }

          Hit.create({ locationId, kind: 'rule', ruleId, keyword, contactId, sessionId: ctx.session.id, replied: ruleReplied }).catch(() => {});
        }
      }
    }

    const settings = (ctx.created || !ruleReplied) ? await Settings.findOne({ locationId }).lean() : null;

    // 2. Welcome — brand-new contacts only
    if (ctx.created && settings?.welcome?.enabled && this._scoped(settings.welcome.sessionIds, ctx.session.id)) {
      if (await this._claim(locationId, contactId, 'welcome', 3650 * DAY)) {
        try {
          const content = await this._content(locationId, { templateId: settings.welcome.templateId, text: settings.welcome.message }, contactId);
          if (content) {
            await this._sendAuto(ctx, content, { kind: 'welcome' });
            Hit.create({ locationId, kind: 'welcome', contactId, sessionId: ctx.session.id, replied: true }).catch(() => {});
          }
        } catch (err) {
          console.warn(`${tag} welcome failed: ${err.code || ''} ${err.message}`);
        }
      }
    }

    // 3. Away — outside business hours, and no rule already replied
    const away = settings?.away;
    if (!ruleReplied && away?.enabled && this._scoped(away.sessionIds, ctx.session.id)) {
      const tz = await this.templates.timezone(locationId, away.timezone);
      const schedule = Array.isArray(away.schedule) && away.schedule.length === 7 ? away.schedule : DEFAULT_SCHEDULE;
      if (!isOpen(schedule, tz)) {
        const windowMs = (away.cooldownHours ?? 12) * 60 * 60 * 1000;
        if (await this._claim(locationId, contactId, 'away', windowMs)) {
          try {
            const content = await this._content(locationId, { templateId: away.templateId, text: away.message }, contactId);
            if (content) {
              await this._sendAuto(ctx, content, { kind: 'away' });
              Hit.create({ locationId, kind: 'away', contactId, sessionId: ctx.session.id, replied: true }).catch(() => {});
            } else {
              await this._release(locationId, contactId, 'away');
            }
          } catch (err) {
            // Free the slot so the next message can try again (e.g. number briefly offline).
            await this._release(locationId, contactId, 'away');
            console.warn(`${tag} away message failed: ${err.code || ''} ${err.message}`);
          }
        }
      }
    }
  }

  /** beforeSend hook: render {{variables}} anywhere (CRM, workflows). Never throws. */
  async onBeforeSend(ctx) {
    try {
      if (ctx.meta?.rendered || !TemplateService.hasVariables(ctx.text)) return;
      ctx.text = await this.templates.render(ctx.locationId, ctx.text, { contactId: ctx.contactId });
    } catch (err) {
      console.warn(`[rules] variable render skipped for ${ctx.locationId}: ${err.message}`);
    }
  }

  /** Workflow action send-template. data: { templateId | templateName, numberId? } */
  async sendTemplateAction(payload) {
    const extras = payload?.extras || {};
    const data = payload?.data || payload?.inputData || {};
    const { locationId, contactId } = extras;
    if (!locationId) throw bad('Missing locationId');
    if (!contactId) throw bad('This action needs a contact', 'NO_PHONE');
    const pick = (...names) => names.map((n) => data[n]).find((v) => v !== undefined && v !== null && String(v).trim() !== '');
    const templateId = String(pick('templateId', 'template_id', 'template') || '').trim();
    const templateName = String(pick('templateName', 'template_name', 'name') || '').trim();
    const numberId = String(pick('numberId', 'number_id') || '').trim() || undefined;
    if (!templateId && !templateName) throw bad('Choose a template (templateId or templateName).', 'TEMPLATE_REQUIRED');

    const template = await this.findTemplate(locationId, { templateId, templateName });
    if (!template) throw bad(`WhatsApp template “${templateName || templateId}” was not found in this sub-account.`, 'TEMPLATE_NOT_FOUND');

    const text = await this.templates.render(locationId, template.body || '', { contactId });
    const attachments = template.mediaUrl ? [template.mediaUrl] : [];
    try {
      const r = await this.messaging.send({
        locationId,
        contactId,
        text: text.trim() ? text : '',
        attachments,
        source: 'workflow',
        mirror: true,
        preferredSessionId: numberId,
        meta: { feature: 'rules', rendered: true, templateId: String(template._id) },
      });
      Template.updateOne({ _id: template._id }, { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }).catch(() => {});
      return { sent: true, whatsappMessageId: r.waMessageIds[0], linkedNumber: r.session.phoneNumber, templateName: template.name };
    } catch (err) {
      if (typeof this.workflows._failed === 'function') this.workflows._failed(locationId, contactId, err, text).catch(() => {});
      throw err;
    }
  }
}

module.exports = { RulesService };
