const WaSession = require('../schemas/wa-session.schema');
const MessageLog = require('../schemas/message-log.schema');
const { clearAuthState } = require('../whatsapp/mongo-auth-state');
const { digits } = require('../whatsapp/jid');

const TERMINAL = ['logged_out', 'banned', 'replaced', 'qr_expired'];
const USER_SETTINGS = ['markRead', 'typingSimulation', 'syncPhoneReplies', 'syncGroups', 'doNotCreateContacts', 'disableIncoming'];
const AGENCY_SETTINGS = ['minDelayMs', 'dailyLimit'];

function httpError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * Linked-number lifecycle for a sub-account: link (QR or pairing code), relink, pause/resume,
 * unlink, settings, and keeping the number of live numbers within plan + agency limits.
 */
class NumbersService {
  constructor({ sessionManager, accessService, subscriptionService }) {
    this.manager = sessionManager;
    this.access = accessService;
    this.subscription = subscriptionService;
  }

  _public(doc) {
    const live = this.manager.snapshot(doc._id);
    const status = live?.status || doc.status;
    return {
      id: String(doc._id),
      locationId: doc.locationId,
      label: doc.label,
      index: doc.index || null,
      name: doc.index ? `WhatsApp #${doc.index}` : 'WhatsApp',
      assignedUserIds: doc.assignedUserIds || [],
      phoneNumber: doc.phoneNumber || null,
      waName: doc.waName || '',
      status,
      pausedReason: doc.pausedReason || '',
      reconnectAttempt: live?.retries || 0,
      isDefault: !!doc.isDefault,
      isActive: doc.isActive,
      qr: status === 'qr' ? live?.qr || null : null,
      pairingCode: status === 'pairing' ? live?.pairingCode || null : null,
      settings: {
        markRead: !!doc.settings?.markRead,
        typingSimulation: doc.settings?.typingSimulation !== false,
        syncPhoneReplies: doc.settings?.syncPhoneReplies !== false,
        syncGroups: !!doc.settings?.syncGroups,
        groupMode: doc.settings?.groupMode || 'all',
        doNotCreateContacts: !!doc.settings?.doNotCreateContacts,
        disableIncoming: !!doc.settings?.disableIncoming,
        blacklist: doc.settings?.blacklist || [],
        proxyCountry: doc.settings?.proxyCountry || '',
        minDelayMs: doc.settings?.minDelayMs ?? null,
        dailyLimit: doc.settings?.dailyLimit ?? null,
      },
      sentToday: doc.stats?.sentDate === new Date().toISOString().slice(0, 10) ? doc.stats?.sentToday || 0 : 0,
      totals: { inbound: doc.stats?.totalInbound || 0, outbound: doc.stats?.totalOutbound || 0 },
      connectedAt: doc.connectedAt || null,
      lastSeenAt: doc.lastSeenAt || null,
      lastMessageAt: doc.lastMessageAt || null,
      lastDisconnectAt: doc.lastDisconnectAt || null,
      lastError: doc.lastError || '',
      createdAt: doc.createdAt,
      createdBy: doc.createdBy || null,
    };
  }

  /** Give every number in the location a stable index ("WhatsApp #n"), oldest first. */
  async ensureIndexes(locationId) {
    const missing = await WaSession.find({ locationId, index: { $in: [null, 0] } }).sort({ createdAt: 1 }).select('_id').lean();
    if (!missing.length) return;
    const top = await WaSession.findOne({ locationId, index: { $gt: 0 } }).sort({ index: -1 }).select('index').lean();
    let next = (top?.index || 0) + 1;
    for (const m of missing) await WaSession.updateOne({ _id: m._id, index: { $in: [null, 0] } }, { $set: { index: next++ } });
  }

  async list(locationId) {
    await this.ensureIndexes(locationId);
    const docs = await WaSession.find({ locationId }).sort({ isDefault: -1, createdAt: 1 }).lean();
    return docs.map((d) => this._public(d));
  }

  async get(locationId, sessionId) {
    const doc = await WaSession.findOne({ _id: sessionId, locationId }).lean();
    if (!doc) throw httpError('Number not found', 404, 'NOT_FOUND');
    return doc;
  }

  /** Numbers that occupy a plan slot: everything except never-linked / dead attempts. */
  async usedSlots(locationId, exceptId) {
    const q = { locationId, isActive: true, status: { $nin: [...TERMINAL, 'paused'] } };
    if (exceptId) q._id = { $ne: exceptId };
    return WaSession.countDocuments(q);
  }

  async _ensureSlot(locationId, ev, exceptId) {
    const used = await this.usedSlots(locationId, exceptId);
    if (used >= ev.numberLimit) {
      const why =
        ev.agencyNumberLimit != null && ev.agencyNumberLimit < ev.planNumberLimit
          ? `Your agency allows ${ev.agencyNumberLimit} number(s) for this sub-account.`
          : `Your plan includes ${ev.planNumberLimit} number(s). Upgrade to link more.`;
      throw httpError(`Number limit reached. ${why}`, 402, 'NUMBER_LIMIT');
    }
  }

  /**
   * Start linking a new number. method 'qr' (default) or 'code' (pairing code sent to `phone`).
   * Returns the session; QR / pairing code then streams over /live and also comes back from GET.
   */
  async link(auth, locationId, { label = '', method = 'qr', phone } = {}) {
    const ev = await this.access.ensureCanManageNumbers(auth, locationId);
    await this.subscription.ensureEntitled(locationId);
    if (method === 'code' && digits(phone).length < 8) throw httpError('Enter the full phone number with country code.', 400, 'BAD_PHONE');

    // Reuse an abandoned attempt instead of piling up "pending" rows.
    let doc = await WaSession.findOne({ locationId, registered: false, phoneNumber: { $in: [null, ''] }, status: { $in: ['pending', 'qr', 'pairing', 'qr_expired'] } });
    await this._ensureSlot(locationId, ev, doc?._id);

    const isFirst = !(await WaSession.exists({ locationId, isDefault: true }));
    if (!doc) {
      doc = await WaSession.create({
        locationId,
        companyId: ev.companyId,
        label: String(label).slice(0, 60),
        isDefault: isFirst,
        index: ((await WaSession.findOne({ locationId }).sort({ index: -1 }).select('index').lean())?.index || 0) + 1,
        createdBy: { userId: auth.userId, name: auth.name, scope: auth.scope },
      });
    } else {
      doc.label = String(label || doc.label).slice(0, 60);
      doc.status = 'pending';
      doc.isActive = true;
      doc.lastError = '';
      await doc.save();
    }
    await this.manager.start(doc._id, method === 'code' ? { pairingPhone: phone } : {});
    return this._public(await WaSession.findById(doc._id).lean());
  }

  /** Re-scan for a number that was logged out / expired / replaced (keeps label, settings, history). */
  async relink(auth, locationId, sessionId, { method = 'qr', phone } = {}) {
    const ev = await this.access.ensureCanManageNumbers(auth, locationId);
    await this.subscription.ensureEntitled(locationId);
    const doc = await this.get(locationId, sessionId);
    await this._ensureSlot(locationId, ev, doc._id);
    if (!['connected', 'connecting'].includes(doc.status)) await clearAuthState(doc._id);
    await WaSession.updateOne({ _id: doc._id }, { $set: { isActive: true, status: 'pending', registered: false, lastError: '', pausedReason: '' } });
    await this.manager.start(doc._id, method === 'code' ? { pairingPhone: phone || doc.phoneNumber } : {});
    return this._public(await WaSession.findById(doc._id).lean());
  }

  /** Reconnect a disconnected / manually paused number without re-scanning. */
  async resume(auth, locationId, sessionId) {
    const ev = await this.access.ensureCanManageNumbers(auth, locationId);
    const doc = await this.get(locationId, sessionId);
    if (!doc.registered) throw httpError('This number needs to be linked again — scan a new QR code.', 409, 'NEEDS_RELINK');
    if (doc.status === 'paused') await this._ensureSlot(locationId, ev, doc._id);
    await WaSession.updateOne({ _id: doc._id }, { $set: { isActive: true, pausedReason: '', status: 'connecting' } });
    await this.manager.start(doc._id);
    return this._public(await WaSession.findById(doc._id).lean());
  }

  async pause(auth, locationId, sessionId) {
    await this.access.ensureCanManageNumbers(auth, locationId);
    const doc = await this.get(locationId, sessionId);
    await this.manager.stop(doc._id, { status: 'paused', pausedReason: 'manual' });
    return this._public(await WaSession.findById(doc._id).lean());
  }

  /** Cancel an in-progress QR/pairing attempt. */
  async cancel(auth, locationId, sessionId) {
    await this.access.ensureCanManageNumbers(auth, locationId);
    const doc = await this.get(locationId, sessionId);
    await this.manager.stop(doc._id, { status: doc.registered ? 'disconnected' : 'qr_expired' });
    if (!doc.registered && !doc.phoneNumber) {
      await clearAuthState(doc._id);
      await WaSession.deleteOne({ _id: doc._id });
      return { removed: true };
    }
    return this._public(await WaSession.findById(doc._id).lean());
  }

  /** Unlink from the phone and remove. Message history stays in the CRM. */
  async unlink(auth, locationId, sessionId) {
    await this.access.ensureCanManageNumbers(auth, locationId).catch((err) => {
      // An agency that disabled a sub-account must still be able to clean its numbers up.
      if (!(auth.scope === 'agency' && err.code === 'ACCESS_DISABLED')) throw err;
    });
    const doc = await this.get(locationId, sessionId);
    await this.manager.logout(doc._id);
    await WaSession.deleteOne({ _id: doc._id });
    if (doc.isDefault) {
      const next = await WaSession.findOne({ locationId }).sort({ status: 1, createdAt: 1 });
      if (next) await WaSession.updateOne({ _id: next._id }, { $set: { isDefault: true } });
    }
    return { removed: true };
  }

  async update(auth, locationId, sessionId, patch = {}) {
    const doc = await this.get(locationId, sessionId);
    const $set = {};
    if ('label' in patch) $set.label = String(patch.label || '').slice(0, 60);
    const s = patch.settings || {};
    for (const k of USER_SETTINGS) if (k in s) $set[`settings.${k}`] = !!s[k];
    for (const k of AGENCY_SETTINGS) {
      if (!(k in s)) continue;
      if (auth.scope !== 'agency') throw httpError('Only your agency can change sending limits.', 403, 'AGENCY_ONLY');
      const v = s[k] === null || s[k] === '' ? null : Number(s[k]);
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw httpError(`${k} must be a positive number`, 400);
      if (k === 'minDelayMs' && v !== null && v < 300) throw httpError('Minimum delay must be at least 300 ms.', 400);
      $set[`settings.${k}`] = v === null ? null : Math.round(v);
    }
    if ('assignedUserIds' in patch) {
      if (!Array.isArray(patch.assignedUserIds)) throw httpError('assignedUserIds must be an array', 400);
      $set.assignedUserIds = [...new Set(patch.assignedUserIds.map((x) => String(x).trim()).filter(Boolean))].slice(0, 100);
    }
    if ('blacklist' in s) {
      if (!Array.isArray(s.blacklist)) throw httpError('blacklist must be an array', 400);
      const nums = s.blacklist.map((x) => String(x).replace(/[^\d]/g, '')).filter((d) => d.length >= 7 && d.length <= 15);
      $set['settings.blacklist'] = [...new Set(nums)].slice(0, 1000).map((d) => `+${d}`);
    }
    if ('groupMode' in s) {
      if (!['all', 'selected'].includes(s.groupMode)) throw httpError('groupMode must be "all" or "selected"', 400);
      $set['settings.groupMode'] = s.groupMode;
    }
    if ('proxyCountry' in s) $set['settings.proxyCountry'] = String(s.proxyCountry || '').toUpperCase().slice(0, 2);
    if (patch.isDefault === true) {
      await WaSession.updateMany({ locationId, _id: { $ne: doc._id } }, { $set: { isDefault: false } });
      $set.isDefault = true;
    }
    if (Object.keys($set).length) {
      await WaSession.updateOne({ _id: doc._id }, { $set });
      this.manager.emit('session.settings', { sessionId: String(doc._id), locationId });
    }
    return this._public(await WaSession.findById(doc._id).lean());
  }

  async activity(locationId, { sessionId, limit = 50, before } = {}) {
    const q = { locationId };
    if (sessionId) q.sessionId = String(sessionId);
    if (before) q.createdAt = { $lt: new Date(before) };
    const rows = await MessageLog.find(q).sort({ createdAt: -1 }).limit(Math.min(200, Number(limit) || 50)).lean();
    return rows.map((r) => ({
      id: String(r._id),
      sessionId: r.sessionId,
      direction: r.direction,
      source: r.source,
      kind: r.kind,
      preview: r.preview,
      status: r.status,
      error: r.error,
      phone: r.waJid && r.waJid.endsWith('@s.whatsapp.net') ? `+${r.waJid.split('@')[0]}` : '',
      ghlContactId: r.ghlContactId || null,
      at: r.createdAt,
    }));
  }

  async stats(locationId) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await MessageLog.aggregate([
      { $match: { locationId, createdAt: { $gte: since } } },
      { $group: { _id: { d: '$direction', s: '$status' }, n: { $sum: 1 } } },
    ]);
    const out = { inbound24h: 0, outbound24h: 0, failed24h: 0 };
    for (const r of rows) {
      if (r._id.d === 'inbound') out.inbound24h += r.n;
      else out.outbound24h += r.n;
      if (r._id.s === 'failed') out.failed24h += r.n;
    }
    return out;
  }

  // ── Policy enforcement (agency toggles, plan changes, uninstall) ──────

  /** Pause numbers beyond the effective limit (keeps the most recently active), resume plan-paused ones under it. */
  async reconcile(locationId) {
    const ev = await this.access.evaluate(locationId);
    if (!ev.allowed) return this.pauseLocation(locationId, 'agency_disabled');

    const live = await WaSession.find({ locationId, isActive: true, status: { $nin: [...TERMINAL, 'paused'] } })
      .sort({ isDefault: -1, lastMessageAt: -1, createdAt: 1 })
      .lean();
    for (const s of live.slice(ev.numberLimit)) {
      await this.manager.stop(s._id, { status: 'paused', pausedReason: 'plan_limit' });
    }
    let free = ev.numberLimit - Math.min(live.length, ev.numberLimit);
    if (free > 0) {
      const paused = await WaSession.find({ locationId, status: 'paused', pausedReason: { $in: ['plan_limit', 'agency_disabled'] }, registered: true })
        .sort({ isDefault: -1, lastMessageAt: -1 })
        .lean();
      for (const s of paused) {
        if (free <= 0) break;
        await WaSession.updateOne({ _id: s._id }, { $set: { pausedReason: '', status: 'connecting', isActive: true } });
        this.manager.start(s._id).catch((err) => console.warn(`[Numbers] resume ${s._id} failed: ${err.message}`));
        free -= 1;
      }
    }
    return { limit: ev.numberLimit };
  }

  async pauseLocation(locationId, reason) {
    const live = await WaSession.find({ locationId, status: { $nin: [...TERMINAL, 'paused'] } }).select('_id').lean();
    for (const s of live) await this.manager.stop(s._id, { status: 'paused', pausedReason: reason });
    return { paused: live.length };
  }

  async logoutLocation(locationId) {
    const all = await WaSession.find({ locationId }).select('_id').lean();
    for (const s of all) {
      try {
        await this.manager.logout(s._id);
      } catch (err) {
        console.warn(`[Numbers] logout ${s._id} on uninstall failed: ${err.message}`);
      }
    }
    return { loggedOut: all.length };
  }
}

module.exports = NumbersService;
