const nodeCrypto = require('crypto');
const mongoose = require('mongoose');
const WaSession = require('../../schemas/wa-session.schema');
const Installation = require('../../schemas/installation.schema');
const { digits } = require('../../whatsapp/jid');
const { ShareLink } = require('./models');

const DEFAULT_HOURS = 24;
const MAX_HOURS = 7 * 24;
const AFTER_USE_MS = 10 * 60 * 1000; // public page keeps showing "connected" this long
const MAX_ACTIVE_PER_LOCATION = 50;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const LIVE_LINKING = ['pending', 'qr', 'pairing', 'connecting'];
const SHOW_ERROR = ['qr_expired', 'logged_out', 'banned', 'replaced', 'paused'];

const GONE = {
  LINK_INVALID: 'This link isn’t valid. Ask the person who sent it for a new one.',
  LINK_EXPIRED: 'This link has expired. Ask the person who sent it for a new one.',
  LINK_REVOKED: 'This link was turned off by the person who sent it. Ask them for a new one.',
  LINK_USED: 'This link has already been used to connect a number. Ask for a new link if you need to connect another.',
};

// What the client sees when the sub-account itself can't take a number right now. The client
// is not the CRM user, so we don't echo plan / agency wording at them.
const CLIENT_SAFE = {
  NUMBER_LIMIT: 'This account can’t take another WhatsApp number right now. Please let the person who sent the link know.',
  SUBSCRIPTION_REQUIRED: 'This account isn’t able to connect WhatsApp right now. Please let the person who sent the link know.',
  ACCESS_DISABLED: 'WhatsApp isn’t switched on for this account yet. Please let the person who sent the link know.',
  AGENCY_MANAGED: 'This link can no longer be used. Ask the person who sent it for a new one.',
  NOT_FOUND: 'This link can no longer be used. Ask the person who sent it for a new one.',
};

function httpError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}
const gone = (code) => httpError(GONE[code], 410, code);
const hashToken = (token) => nodeCrypto.createHash('sha256').update(String(token)).digest('hex');
const validId = (id) => !!id && mongoose.Types.ObjectId.isValid(String(id));

/**
 * Shareable "connect your WhatsApp" links. The creator's identity is captured at creation and
 * replayed (as a synthetic auth) when the client starts linking, so a link created by the
 * agency works even when the sub-account has self-connect off.
 */
class ShareService {
  constructor({ numbersService, sessionManager, accessService, subscriptionService, ghlService }) {
    this.numbers = numbersService;
    this.manager = sessionManager;
    this.access = accessService;
    this.subscription = subscriptionService;
    this.ghl = ghlService;
    this._names = new Map(); // locationId → { name, at }

    this.manager.on('status', (ev) => {
      if (ev?.status === 'connected' && ev.sessionId) this._markUsed(ev.sessionId).catch(() => {});
    });
  }

  // ── Authenticated (CRM) side ─────────────────────────────────

  async create(auth, locationId, { numberId, label, expiresHours } = {}) {
    const ev = await this.access.ensureCanManageNumbers(auth, locationId);
    await this.subscription.ensureEntitled(locationId);

    const active = await ShareLink.countDocuments({ locationId, revokedAt: null, usedAt: null, expiresAt: { $gt: new Date() } });
    if (active >= MAX_ACTIVE_PER_LOCATION) throw httpError('Too many open links for this sub-account. Revoke some first.', 429, 'TOO_MANY_LINKS');

    let number = null;
    if (numberId) {
      if (!validId(numberId)) throw httpError('Number not found', 404, 'NOT_FOUND');
      number = await WaSession.findOne({ _id: numberId, locationId }).lean();
      if (!number) throw httpError('Number not found', 404, 'NOT_FOUND');
      const live = this.manager.snapshot(number._id)?.status || number.status;
      if (['connected', 'connecting', 'disconnected'].includes(live) || (live === 'paused' && number.registered)) {
        throw httpError('This number is still linked — resume it instead of sending a link.', 409, 'ALREADY_LINKED');
      }
    }

    const hours = Math.min(MAX_HOURS, Math.max(1, Number(expiresHours) || DEFAULT_HOURS));
    const token = nodeCrypto.randomBytes(32).toString('base64url');
    const doc = await ShareLink.create({
      tokenHash: hashToken(token),
      locationId,
      companyId: ev.companyId || auth.companyId || '',
      numberId: number ? String(number._id) : null,
      label: String(label || number?.label || '').trim().slice(0, 60),
      businessName: await this.businessName(locationId),
      createdBy: { userId: auth.userId || '', name: auth.name || '', scope: auth.scope },
      expiresAt: new Date(Date.now() + hours * 3600 * 1000),
    });

    return { ...this._row(doc.toObject()), url: ShareService.urlFor(token), token };
  }

  static urlFor(token) {
    const base = String(process.env.FRONTEND_URL || '').replace(/\/+$/, '');
    if (!base) console.warn('[share] FRONTEND_URL is not set — returning a relative connect URL');
    return `${base}/connect/${token}`;
  }

  async list(locationId) {
    const docs = await ShareLink.find({ locationId, revokedAt: null, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    const ids = docs.map((d) => d.sessionId).filter(validId);
    const sessions = ids.length ? await WaSession.find({ _id: { $in: ids }, locationId }).select('status phoneNumber waName').lean() : [];
    const byId = new Map(sessions.map((s) => [String(s._id), s]));
    return docs.map((d) => this._row(d, byId.get(String(d.sessionId))));
  }

  _row(d, session) {
    const live = session ? this.manager.snapshot(session._id)?.status || session.status : null;
    let state = 'pending';
    if (d.usedAt) state = 'connected';
    else if (live && LIVE_LINKING.includes(live)) state = 'in_progress';
    return {
      id: String(d._id),
      label: d.label || '',
      numberId: d.numberId || null,
      sessionId: d.sessionId || null,
      state, // pending | in_progress | connected
      sessionStatus: live,
      phoneNumber: d.usedAt ? session?.phoneNumber || null : null,
      createdBy: d.createdBy ? { name: d.createdBy.name || '', scope: d.createdBy.scope } : null,
      createdAt: d.createdAt,
      expiresAt: d.expiresAt,
      usedAt: d.usedAt || null,
    };
  }

  async revoke(auth, locationId, id) {
    await this.access.ensureCanManageNumbers(auth, locationId);
    if (!validId(id)) throw httpError('Link not found', 404, 'NOT_FOUND');
    const doc = await ShareLink.findOneAndUpdate({ _id: id, locationId, revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true }).lean();
    if (!doc) throw httpError('Link not found', 404, 'NOT_FOUND');
    // Stop a half-finished attempt so the client's QR dies with the link.
    if (!doc.usedAt && validId(doc.sessionId)) {
      const s = await WaSession.findOne({ _id: doc.sessionId, locationId }).select('status').lean();
      const status = s && (this.manager.snapshot(s._id)?.status || s.status);
      if (s && ['pending', 'qr', 'pairing'].includes(status)) {
        await this.numbers.cancel(auth, locationId, s._id).catch((err) => console.warn(`[share] cancel on revoke failed: ${err.message}`));
      }
    }
    return { revoked: true, id: String(doc._id) };
  }

  // ── Public (client) side ─────────────────────────────────────

  /** Resolve a raw token to its link, or throw 410. `forWrite` refuses links already used. */
  async _load(token, { forWrite = false } = {}) {
    // The token's sha256 is the lookup key, so response timing never depends on how much of a
    // guessed token is right (no string compare against stored secrets).
    if (!TOKEN_RE.test(String(token || ''))) throw gone('LINK_INVALID');
    const link = await ShareLink.findOne({ tokenHash: hashToken(token) });
    if (!link) throw gone('LINK_INVALID');
    if (link.revokedAt) throw gone('LINK_REVOKED');
    const now = Date.now();
    if (link.usedAt) {
      if (now - link.usedAt.getTime() > AFTER_USE_MS) throw gone('LINK_USED');
      if (forWrite) throw httpError('This number is already connected.', 409, 'ALREADY_CONNECTED');
      return link;
    }
    if (link.expiresAt.getTime() <= now) throw gone('LINK_EXPIRED');
    return link;
  }

  _authFor(link) {
    return {
      scope: link.createdBy?.scope === 'agency' ? 'agency' : 'location',
      userId: link.createdBy?.userId || '',
      name: link.createdBy?.name || 'Share link',
      companyId: link.companyId,
      locationId: link.locationId,
      viaShareLink: String(link._id),
    };
  }

  async _session(link) {
    if (!validId(link.sessionId)) return null;
    return WaSession.findOne({ _id: link.sessionId, locationId: link.locationId }).lean();
  }

  async _markUsed(sessionId) {
    const now = new Date();
    await ShareLink.updateOne(
      { sessionId: String(sessionId), usedAt: null, revokedAt: null },
      { $set: { usedAt: now }, $max: { expiresAt: new Date(now.getTime() + AFTER_USE_MS) } },
    );
  }

  async publicState(token) {
    const link = await this._load(token);
    return this._state(link);
  }

  async _state(link) {
    const out = {
      businessName: link.businessName || (await this.businessName(link.locationId)),
      label: link.label || '',
      status: 'ready', // ready = not started yet; otherwise the WhatsApp session status
      method: link.method || null,
      qr: null,
      pairingCode: null,
      phoneNumber: null,
      waName: '',
      expiresAt: link.expiresAt,
      lastError: '',
    };
    const doc = await this._session(link);
    if (!doc && link.sessionId && !link.usedAt) {
      // The attempt was cancelled / removed in the CRM — back to the start screen.
      await ShareLink.updateOne({ _id: link._id }, { $set: { sessionId: null } });
    }
    if (doc) {
      const p = this.numbers._public(doc);
      out.status = p.status;
      out.qr = p.qr;
      out.pairingCode = p.pairingCode;
      out.phoneNumber = p.status === 'connected' || link.usedAt ? p.phoneNumber : null;
      out.waName = p.status === 'connected' || link.usedAt ? p.waName : '';
      out.lastError = SHOW_ERROR.includes(p.status) ? String(p.lastError || '').slice(0, 200) : '';
      if (p.status === 'connected' && !link.usedAt) {
        await this._markUsed(doc._id);
        link.usedAt = new Date();
      }
    }
    if (link.usedAt) {
      Object.assign(out, { status: 'connected', qr: null, pairingCode: null, lastError: '' });
    }
    return out;
  }

  async start(token, { method, phone } = {}) {
    const link = await this._load(token, { forWrite: true });
    const m = method === 'code' ? 'code' : 'qr';
    if (m === 'code' && digits(phone).length < 8) throw httpError('Enter the full phone number with country code.', 400, 'BAD_PHONE');
    const auth = this._authFor(link);
    const body = { method: m, phone: m === 'code' ? phone : undefined };

    let target = await this._session(link);
    if (!target && validId(link.numberId)) target = await WaSession.findOne({ _id: link.numberId, locationId: link.locationId }).lean();

    let res;
    if (target) {
      const live = this.manager.snapshot(target._id);
      const status = live?.status || target.status;
      if (status === 'connected') {
        if (String(link.sessionId) !== String(target._id)) {
          link.sessionId = String(target._id);
          await link.save();
        }
        await this._markUsed(target._id);
        return this.publicState(token);
      }
      const samePhone = m !== 'code' || digits(phone) === digits(this.manager.runtimes?.get(String(target._id))?.pairingPhone || '');
      // Already showing a code for the same method → idempotent (double taps, page reloads).
      if (live && LIVE_LINKING.includes(status) && link.method === m && samePhone && String(link.sessionId) === String(target._id)) {
        return this._state(link);
      }
      // Switching method mid-attempt: close the running socket first so it restarts cleanly.
      if (live && status !== 'connected') await this.manager.stop(target._id, { status: 'qr_expired' });
      res = await this.numbers.relink(auth, link.locationId, target._id, body);
    } else {
      // numbersService.link() reuses any in-progress, never-linked attempt in the sub-account.
      // If someone else is mid-scan right now, refuse rather than hand this client their QR.
      const now = new Date();
      const candidate = await WaSession.findOne({
        locationId: link.locationId,
        registered: false,
        phoneNumber: { $in: [null, ''] },
        status: { $in: ['pending', 'qr', 'pairing', 'qr_expired'] },
      })
        .select('_id status leaseUntil')
        .lean();
      const busy =
        candidate &&
        ['pending', 'qr', 'pairing'].includes(this.manager.snapshot(candidate._id)?.status || candidate.status) &&
        (this.manager.snapshot(candidate._id) || (candidate.leaseUntil && candidate.leaseUntil > now));
      if (busy) {
        throw httpError('Someone else is connecting a number for this account right now. Please try again in a couple of minutes.', 409, 'BUSY');
      }
      res = await this.numbers.link(auth, link.locationId, { ...body, label: link.label });
      // A reused abandoned attempt may still be referenced by an older link — detach it there.
      await ShareLink.updateMany({ sessionId: res.id, _id: { $ne: link._id } }, { $set: { sessionId: null } });
    }

    link.sessionId = res.id;
    link.method = m;
    link.startedAt = new Date();
    await link.save();
    return this._state(link);
  }

  async cancel(token) {
    const link = await this._load(token);
    if (link.usedAt) return this._state(link);
    const doc = await this._session(link);
    if (doc) {
      const status = this.manager.snapshot(doc._id)?.status || doc.status;
      if (status !== 'connected') {
        const r = await this.numbers.cancel(this._authFor(link), link.locationId, doc._id);
        if (r?.removed) {
          link.sessionId = null;
          if (String(link.numberId) === String(doc._id)) link.numberId = null;
          link.method = null;
          await link.save();
        }
      }
    }
    return this._state(link);
  }

  /** Errors safe to show the (non-CRM) client. */
  static clientError(err) {
    const status = err.statusCode || 500;
    if (status >= 500) return { status: 500, body: { success: false, error: 'Something went wrong — please try again.' } };
    const msg = CLIENT_SAFE[err.code] || err.message;
    return { status, body: { success: false, error: msg, code: err.code } };
  }

  // ── Business name (best-effort, cached) ──────────────────────

  async businessName(locationId) {
    const hit = this._names.get(locationId);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.name;
    let name = '';
    try {
      const inst = await Installation.findOne({ locationId }).select('locationName').lean();
      name = inst?.locationName || '';
      if (!name && this.ghl?.getLocation) {
        const loc = await Promise.race([this.ghl.getLocation(locationId), new Promise((r) => setTimeout(() => r(null), 4000))]);
        name = loc?.name || '';
      }
    } catch {
      /* best-effort */
    }
    name = String(name).slice(0, 120);
    this._names.set(locationId, { name, at: Date.now() });
    if (this._names.size > 5000) this._names.delete(this._names.keys().next().value);
    return name;
  }
}

module.exports = { ShareService, hashToken };
