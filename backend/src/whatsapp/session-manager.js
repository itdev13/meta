const { EventEmitter } = require('events');
const os = require('os');
const pino = require('pino');
const QRCode = require('qrcode');
const baileys = require('@whiskeysockets/baileys');
const WaSession = require('../schemas/wa-session.schema');
const { useMongoAuthState, clearAuthState } = require('./mongo-auth-state');
const { normalizeJid, jidToPhone, isIgnorableJid, digits } = require('./jid');
const { formatError } = require('../utils/format-error');

const makeWASocket = baileys.default || baileys.makeWASocket;
const { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } = baileys;

const LEASE_MS = 90 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const SENT_CACHE_SIZE = 300;
const LIVE = new Set(['qr', 'pairing', 'connecting', 'connected', 'disconnected']);

/**
 * Pool of live WhatsApp (Baileys) sockets, one per linked number, keyed by session _id.
 *
 * Ownership: each session is leased to exactly one process (ownerId + leaseUntil, renewed by a
 * heartbeat). Two processes driving one session makes WhatsApp kick the device ("replaced") —
 * the same failure mode Telegram hit with AUTH_KEY_DUPLICATED — so we never start a socket
 * without holding the lease.
 *
 * Events (consumed by InboundService / SSE):
 *   'status'           public session snapshot whenever status/QR/pairing code changes
 *   'messages.upsert'  { session, sock, messages, type }
 *   'messages.update'  { session, updates }
 *   'session.closed'   { session, reason }  — terminal: logged_out | banned | replaced
 */
class SessionManager extends EventEmitter {
  constructor(cryptoService) {
    super();
    this.setMaxListeners(1000);
    this.crypto = cryptoService;
    this.instanceId = process.env.INSTANCE_ID || `${os.hostname()}-${process.pid}`;
    this.runtimes = new Map();
    this.logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });
    this.maxQr = Number(process.env.WA_MAX_QR_PER_ATTEMPT) || 6;
    this._version = null;
    this._heartbeat = setInterval(() => this._renewLeases().catch(() => {}), HEARTBEAT_MS);
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * Start (or resume) a session. opts.pairingPhone → link with an 8-character pairing code
   * instead of a QR. Resolves once the socket is created; progress arrives via 'status'.
   */
  async start(sessionId, opts = {}) {
    const id = String(sessionId);
    const existing = this.runtimes.get(id);
    if (existing && !existing.stopping && existing.sock) {
      if (opts.pairingPhone && existing.status !== 'connected') {
        // Switching an in-progress QR attempt to pairing-code mode → restart cleanly.
        await this._teardown(id);
      } else {
        return this.snapshot(id);
      }
    }

    const claimed = await this._claimLease(id);
    if (!claimed) {
      const err = new Error('This number is being handled by another server — try again in a minute.');
      err.statusCode = 409;
      err.code = 'SESSION_LEASED';
      throw err;
    }

    const session = await WaSession.findById(id).lean();
    if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404 });

    const runtime = {
      id,
      locationId: session.locationId,
      companyId: session.companyId,
      gen: (existing?.gen || 0) + 1,
      sock: null,
      status: 'connecting',
      qr: null,
      pairingCode: null,
      pairingPhone: opts.pairingPhone ? digits(opts.pairingPhone) : null,
      pairingRequested: false,
      qrCount: 0,
      retries: existing?.retries || 0,
      stopping: false,
      reconnectTimer: null,
      sentCache: new Map(),
    };
    this.runtimes.set(id, runtime);
    await this._connect(runtime);
    return this.snapshot(id);
  }

  /** Close the socket but KEEP the linked device (resume later without re-scanning). */
  async stop(sessionId, { status = 'disconnected', pausedReason = '', isActive } = {}) {
    const id = String(sessionId);
    await this._teardown(id);
    const $set = { status, pausedReason, ownerId: null, leaseUntil: null };
    if (isActive !== undefined) $set.isActive = isActive;
    await WaSession.updateOne({ _id: id }, { $set });
    this._emitStatus(id, await WaSession.findById(id).lean());
  }

  /** Unlink the device from the phone and wipe its keys. */
  async logout(sessionId, { status = 'logged_out' } = {}) {
    const id = String(sessionId);
    const rt = this.runtimes.get(id);
    if (rt?.sock && rt.status === 'connected') {
      rt.stopping = true;
      try {
        await rt.sock.logout();
      } catch (err) {
        console.warn(`[WA] logout ${id} failed (wiping anyway): ${err.message}`);
      }
    }
    await this._teardown(id);
    await clearAuthState(id);
    await WaSession.updateOne(
      { _id: id },
      { $set: { status, isActive: false, registered: false, ownerId: null, leaseUntil: null, lastDisconnectAt: new Date() } },
    );
    this._emitStatus(id, await WaSession.findById(id).lean());
  }

  isConnected(sessionId) {
    return this.runtimes.get(String(sessionId))?.status === 'connected';
  }

  getSocket(sessionId) {
    const rt = this.runtimes.get(String(sessionId));
    if (!rt?.sock || rt.status !== 'connected') {
      const err = new Error('This WhatsApp number is not connected right now.');
      err.code = 'NUMBER_OFFLINE';
      err.statusCode = 409;
      throw err;
    }
    return rt.sock;
  }

  /** Live snapshot for the UI (includes the current QR, which is never stored). */
  snapshot(sessionId) {
    const rt = this.runtimes.get(String(sessionId));
    if (!rt) return null;
    return { sessionId: rt.id, locationId: rt.locationId, status: rt.status, qr: rt.qr, pairingCode: rt.pairingCode };
  }

  async sendRaw(sessionId, jid, content) {
    const sock = this.getSocket(sessionId);
    const sent = await sock.sendMessage(jid, content);
    const rt = this.runtimes.get(String(sessionId));
    if (rt && sent?.key?.id) {
      rt.sentCache.set(sent.key.id, sent.message);
      if (rt.sentCache.size > SENT_CACHE_SIZE) rt.sentCache.delete(rt.sentCache.keys().next().value);
    }
    return sent;
  }

  async typing(sessionId, jid, ms) {
    try {
      const sock = this.getSocket(sessionId);
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate('composing', jid);
      await new Promise((r) => setTimeout(r, ms));
      await sock.sendPresenceUpdate('paused', jid);
    } catch {
      /* cosmetic */
    }
  }

  async readMessages(sessionId, keys) {
    try {
      await this.getSocket(sessionId).readMessages(keys);
    } catch {
      /* best-effort */
    }
  }

  /** → { exists, jid } for a phone number, via the given session. */
  async lookupNumber(sessionId, phone) {
    const d = digits(phone);
    if (!d) return { exists: false, jid: null };
    const [hit] = (await this.getSocket(sessionId).onWhatsApp(d)) || [];
    return { exists: !!hit?.exists, jid: hit?.jid ? normalizeJid(hit.jid) : null };
  }

  /** Restore every session that should be live, staggered so WhatsApp doesn't see a burst. */
  async restoreAll() {
    const stagger = Number(process.env.WA_RESTORE_STAGGER_MS) || 1500;
    const sessions = await WaSession.find({
      isActive: true,
      registered: true,
      status: { $nin: ['paused', 'logged_out', 'banned', 'replaced', 'qr_expired'] },
      $or: [{ ownerId: null }, { ownerId: this.instanceId }, { leaseUntil: { $lt: new Date() } }],
    })
      .select('_id')
      .lean();
    console.log(`[WA] restoring ${sessions.length} session(s) on ${this.instanceId}`);
    for (const s of sessions) {
      this.start(s._id).catch((err) => console.warn(`[WA] restore ${s._id} failed: ${err.message}`));
      await new Promise((r) => setTimeout(r, stagger));
    }
  }

  /** Graceful shutdown: close sockets, keep links, release leases so another instance can take over. */
  async shutdown() {
    clearInterval(this._heartbeat);
    const ids = [...this.runtimes.keys()];
    for (const id of ids) await this._teardown(id);
    if (ids.length) {
      await WaSession.updateMany({ _id: { $in: ids }, ownerId: this.instanceId }, { $set: { ownerId: null, leaseUntil: null } });
    }
  }

  // ── Internals ────────────────────────────────────────────────

  async _claimLease(id) {
    const now = new Date();
    const res = await WaSession.findOneAndUpdate(
      { _id: id, $or: [{ ownerId: null }, { ownerId: this.instanceId }, { leaseUntil: { $lt: now } }] },
      { $set: { ownerId: this.instanceId, leaseUntil: new Date(now.getTime() + LEASE_MS) } },
      { new: true },
    ).lean();
    return !!res;
  }

  async _renewLeases() {
    const ids = [...this.runtimes.keys()];
    if (!ids.length) return;
    const now = new Date();
    await WaSession.updateMany(
      { _id: { $in: ids }, ownerId: this.instanceId },
      { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) } },
    );
    const connected = ids.filter((id) => this.runtimes.get(id)?.status === 'connected');
    if (connected.length) await WaSession.updateMany({ _id: { $in: connected } }, { $set: { lastSeenAt: now } });
  }

  async _version_() {
    if (this._version) return this._version;
    try {
      const { version } = await fetchLatestBaileysVersion();
      this._version = version;
    } catch {
      this._version = undefined; // Baileys falls back to its bundled version
    }
    return this._version;
  }

  async _connect(rt) {
    // New generation per socket: events from a previous (closed) socket are ignored.
    rt.gen += 1;
    const gen = rt.gen;
    if (rt.sock) {
      try {
        rt.sock.ev.removeAllListeners();
      } catch {
        /* ignore */
      }
    }
    const { state, saveCreds } = await useMongoAuthState(rt.id, this.crypto);
    const version = await this._version_();

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      logger: this.logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger) },
      browser: Browsers.macOS(process.env.WA_BROWSER_NAME || 'Chrome'),
      // Don't mark the business "online" — otherwise the phone stops getting push notifications.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Our own API sends must NOT come back as messages.upsert (they'd be mirrored as
      // "typed on the phone"). Messages typed on the phone still arrive from the server.
      emitOwnEvents: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      shouldIgnoreJid: (jid) => isIgnorableJid(jid),
      getMessage: async (key) => rt.sentCache.get(key.id),
    });
    rt.sock = sock;

    sock.ev.on('creds.update', () => {
      saveCreds().catch((err) => console.error(`[WA] saveCreds ${rt.id} failed: ${err.message}`));
    });

    sock.ev.on('connection.update', (update) => {
      if (rt.gen !== gen || rt.stopping) return;
      this._onConnectionUpdate(rt, sock, state, update).catch((err) =>
        console.error(`[WA] connection.update ${rt.id} handler error | ${formatError(err)}`),
      );
    });

    sock.ev.on('messages.upsert', (payload) => {
      if (rt.gen !== gen) return;
      this.emit('messages.upsert', { session: this._sessionRef(rt), sock, ...payload });
    });

    sock.ev.on('messages.update', (updates) => {
      if (rt.gen !== gen) return;
      this.emit('messages.update', { session: this._sessionRef(rt), updates });
    });
  }

  _sessionRef(rt) {
    return { id: rt.id, locationId: rt.locationId, companyId: rt.companyId };
  }

  async _onConnectionUpdate(rt, sock, state, { connection, lastDisconnect, qr }) {
    if (qr) {
      if (rt.pairingPhone && !state.creds.registered) {
        if (!rt.pairingRequested) {
          rt.pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(rt.pairingPhone);
            rt.pairingCode = code?.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
            await this._setStatus(rt, 'pairing', { lastError: '' });
          } catch (err) {
            rt.pairingRequested = false;
            await this._setStatus(rt, 'qr_expired', { lastError: `Pairing code failed: ${err.message}` });
            await this._teardown(rt.id, { release: true });
          }
        }
        return;
      }
      rt.qrCount += 1;
      if (rt.qrCount > this.maxQr) {
        await this._setStatus(rt, 'qr_expired', { lastError: 'QR code expired — nobody scanned it in time.' });
        await this._teardown(rt.id, { release: true });
        return;
      }
      rt.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
      await this._setStatus(rt, 'qr');
      return;
    }

    if (connection === 'open') {
      rt.retries = 0;
      rt.qr = null;
      rt.pairingCode = null;
      const jid = normalizeJid(sock.user?.id);
      const phone = jidToPhone(jid);
      await this._setStatus(rt, 'connected', {
        phoneNumber: phone,
        waJid: jid,
        waName: sock.user?.name || sock.user?.verifiedName || '',
        connectedAt: new Date(),
        lastSeenAt: new Date(),
        registered: true,
        isActive: true,
        pausedReason: '',
        lastError: '',
      });
      await this._dedupeNumber(rt, phone);
      console.log(`[WA] ${rt.id} connected as ${phone} (location ${rt.locationId})`);
      return;
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const message = lastDisconnect?.error?.message || '';
      rt.sock = null;
      await WaSession.updateOne({ _id: rt.id }, { $set: { lastDisconnectAt: new Date(), lastDisconnectCode: code || null } });

      if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
        await this._terminal(rt, 'logged_out', 'The number was unlinked from the phone (Linked devices → Log out).');
        return;
      }
      if (code === DisconnectReason.forbidden) {
        await this._terminal(rt, 'banned', 'WhatsApp refused this number (it may be restricted or banned).');
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        await this._setStatus(rt, 'replaced', { lastError: 'Another WhatsApp Web session took over this number.' });
        await this._teardown(rt.id, { release: true });
        this.emit('session.closed', { session: this._sessionRef(rt), reason: 'replaced' });
        return;
      }
      if (code === DisconnectReason.restartRequired) {
        // Normal right after a fresh link — reconnect immediately with the new creds.
        await this._connect(rt);
        return;
      }

      if (!state.creds.registered) {
        // Never finished linking (QR timed out / socket dropped mid-pair).
        await this._setStatus(rt, 'qr_expired', { lastError: message ? `Linking interrupted: ${message}` : 'Linking timed out.' });
        await this._teardown(rt.id, { release: true });
        return;
      }

      rt.retries += 1;
      const delay = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** Math.min(rt.retries - 1, 8)) + Math.floor(Math.random() * 1000);
      await this._setStatus(rt, 'disconnected', { lastError: `Connection lost (${code || 'network'}) — reconnecting.` });
      console.warn(`[WA] ${rt.id} closed (${code}) — reconnect #${rt.retries} in ${Math.round(delay / 1000)}s`);
      rt.reconnectTimer = setTimeout(() => {
        if (rt.stopping || this.runtimes.get(rt.id) !== rt) return;
        rt.status = 'connecting';
        this._connect(rt).catch((err) => console.error(`[WA] reconnect ${rt.id} failed | ${formatError(err)}`));
      }, delay);
    }
  }

  async _terminal(rt, status, lastError) {
    await this._teardown(rt.id, { release: true });
    await clearAuthState(rt.id);
    await WaSession.updateOne({ _id: rt.id }, { $set: { status, lastError, isActive: false, registered: false } });
    this._emitStatus(rt.id, await WaSession.findById(rt.id).lean());
    this.emit('session.closed', { session: this._sessionRef(rt), reason: status });
    console.warn(`[WA] ${rt.id} terminal: ${status}`);
  }

  /** Linking the same number twice in one sub-account → keep the new link, retire the old one. */
  async _dedupeNumber(rt, phone) {
    if (!phone) return;
    const dups = await WaSession.find({ locationId: rt.locationId, phoneNumber: phone, _id: { $ne: rt.id } }).select('_id isDefault').lean();
    for (const d of dups) {
      try {
        await this.logout(d._id, { status: 'logged_out' });
      } catch {
        /* ignore */
      }
      if (d.isDefault) await WaSession.updateOne({ _id: rt.id }, { $set: { isDefault: true } });
      await WaSession.deleteOne({ _id: d._id });
    }
  }

  async _teardown(id, { release = false } = {}) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.stopping = true;
    clearTimeout(rt.reconnectTimer);
    if (rt.sock) {
      try {
        rt.sock.ev.removeAllListeners();
        rt.sock.end(undefined);
      } catch {
        /* ignore */
      }
    }
    rt.sock = null;
    this.runtimes.delete(id);
    if (release) await WaSession.updateOne({ _id: id, ownerId: this.instanceId }, { $set: { ownerId: null, leaseUntil: null } });
  }

  async _setStatus(rt, status, patch = {}) {
    rt.status = status;
    const doc = await WaSession.findOneAndUpdate({ _id: rt.id }, { $set: { status, ...patch } }, { new: true }).lean();
    this._emitStatus(rt.id, doc);
  }

  _emitStatus(id, doc) {
    if (!doc) return;
    const rt = this.runtimes.get(String(id));
    this.emit('status', {
      sessionId: String(doc._id),
      locationId: doc.locationId,
      companyId: doc.companyId,
      status: doc.status,
      live: LIVE.has(doc.status),
      qr: rt?.status === 'qr' ? rt.qr : null,
      pairingCode: rt?.status === 'pairing' ? rt.pairingCode : null,
      phoneNumber: doc.phoneNumber || null,
      waName: doc.waName || '',
      lastError: doc.lastError || '',
    });
  }
}

module.exports = SessionManager;
