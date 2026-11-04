const { EventEmitter } = require('events');
const logger = require('../utils/logger');
const os = require('os');
const pino = require('pino');
const QRCode = require('qrcode');
const baileys = require('@whiskeysockets/baileys');
const WaSession = require('../schemas/wa-session.schema');
const { useMongoAuthState, clearAuthState } = require('./mongo-auth-state');
const { normalizeJid, jidToPhone, isIgnorableJid, digits } = require('./jid');
const { formatError } = require('../utils/format-error');
const proxyPool = require('../features/proxy/proxy-pool');

const makeWASocket = baileys.default || baileys.makeWASocket;
const { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } = baileys;

const LEASE_MS = 90 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const SENT_CACHE_SIZE = 300;
const LIVE = new Set(['qr', 'pairing', 'connecting', 'connected', 'disconnected']);
// Watchdog: restart registered sessions stuck connecting (or disconnected with no retry pending).
const WATCHDOG_MS = 60 * 1000;
const STUCK_CONNECTING_MS = 2 * 60 * 1000;
// Crash containment: more than ERROR_LIMIT handler errors inside ERROR_WINDOW_MS → pause the session.
const ERROR_LIMIT = 20;
const ERROR_WINDOW_MS = 5 * 60 * 1000;
const PAUSED_FOR_ERRORS = 'Paused after repeated errors; reconnect to retry';

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
    // sessionId → timestamps of recent handler errors (survives watchdog restarts on purpose).
    this._errorLog = new Map();
    this._watchdogBusy = false;
    this._watchdog = setInterval(() => {
      this._runWatchdog().catch((err) => console.error(`[WA] watchdog error | ${formatError(err)}`));
    }, WATCHDOG_MS);
    if (this._watchdog.unref) this._watchdog.unref();
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

    // A user-initiated (re)connect gets a clean error budget; watchdog restarts keep the history
    // so a session that keeps crashing is still paused instead of hot-looping.
    if (!opts.fromWatchdog) this._errorLog.delete(id);

    const runtime = {
      id,
      locationId: session.locationId,
      companyId: session.companyId,
      gen: (existing?.gen || 0) + 1,
      sock: null,
      status: 'connecting',
      statusAt: Date.now(),
      proxy: null, // { country, masked } of the proxy used by the current socket, or null (direct)
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
    try {
      await this._connect(runtime);
    } catch (err) {
      // Leave the runtime in place (status 'connecting', no socket): the watchdog retries it.
      this._recordError(runtime, 'connect', err);
      throw err;
    }
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
    return {
      sessionId: rt.id,
      locationId: rt.locationId,
      status: rt.status,
      qr: rt.qr,
      pairingCode: rt.pairingCode,
      retries: rt.retries || 0,
      proxyCountry: rt.proxy?.country || null,
    };
  }

  /**
   * http(s).Agent for this session's proxy (or undefined when direct). Baileys downloads media
   * with axios, so pass it to downloadMediaMessage as `{ options: { httpsAgent: agent } }` to
   * make downloads leave from the same IP as the socket. (Uploads already use it via fetchAgent.)
   */
  getProxyAgent(sessionId) {
    return this.runtimes.get(String(sessionId))?.proxyAgent || undefined;
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
  /**
   * Bring every live number back after a restart — as a bounded queue, not a burst:
   *   • at most WA_RESTORE_CONCURRENCY (default 5) numbers are handshaking at any moment
   *   • each slot waits until its number is connected / needs a QR / failed (max 45s) before
   *     taking the next one, plus a small gap (WA_RESTORE_STAGGER_MS, default 1500)
   *   • most recently active numbers go first, so busy clients are back first
   * Outbound sends for a number still in the queue wait for it (see waitForLocation) instead
   * of failing. Returns immediately; restore runs in the background.
   */
  async restoreAll() {
    const stagger = Number(process.env.WA_RESTORE_STAGGER_MS) || 1500;
    const concurrency = Math.max(1, Number(process.env.WA_RESTORE_CONCURRENCY) || 5);
    const sessions = await WaSession.find({
      isActive: true,
      registered: true,
      status: { $nin: ['paused', 'logged_out', 'banned', 'replaced', 'qr_expired'] },
      $or: [{ ownerId: null }, { ownerId: this.instanceId }, { leaseUntil: { $lt: new Date() } }],
    })
      .sort({ lastMessageAt: -1, connectedAt: -1 })
      .select('_id locationId')
      .lean();

    this._restoring = new Map(sessions.map((s) => [String(s._id), s.locationId]));
    const queue = sessions.map((s) => String(s._id));
    const started = Date.now();
    logger.info('♻️ Restoring WhatsApp numbers', { count: queue.length, instance: this.instanceId, concurrency });

    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try {
          await this.start(id);
          await this._waitSettled(id, 45_000);
        } catch (err) {
          console.warn(`[WA] restore ${id} failed: ${err.message}`);
        } finally {
          this._restoring.delete(id);
          this.emit('restore.progress', { sessionId: id });
        }
        if (queue.length) await new Promise((r) => setTimeout(r, stagger));
      }
    };
    Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker)).then(() => {
      if (sessions.length) logger.info('✅ Restore complete', { count: sessions.length, seconds: Math.round((Date.now() - started) / 1000) });
    });
  }

  /** Resolve once a session reaches a settled state (or after timeoutMs). */
  _waitSettled(id, timeoutMs) {
    const SETTLED = new Set(['connected', 'qr', 'pairing', 'qr_expired', 'logged_out', 'banned', 'replaced', 'paused', 'disconnected']);
    const now = this.runtimes.get(id)?.status;
    if (now && now !== 'connecting' && SETTLED.has(now)) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (status) => {
        clearTimeout(timer);
        this.off('status', onStatus);
        resolve(status);
      };
      const onStatus = (evt) => {
        if (evt.sessionId === id && SETTLED.has(evt.status)) done(evt.status);
      };
      const timer = setTimeout(() => done('timeout'), timeoutMs);
      this.on('status', onStatus);
    });
  }

  /** True while a location still has numbers queued for restore or mid-(re)connect. */
  hasPendingNumbers(locationId) {
    for (const loc of (this._restoring || new Map()).values()) if (loc === locationId) return true;
    for (const rt of this.runtimes.values()) {
      if (rt.locationId === locationId && (rt.status === 'connecting' || rt.status === 'disconnected')) return true;
    }
    return false;
  }

  /**
   * For senders: if none of the location's numbers is connected yet but some are restoring or
   * reconnecting, wait (up to timeoutMs) for one to come online. Resolves true if one did.
   */
  async waitForLocation(locationId, timeoutMs = Number(process.env.WA_SEND_WAIT_MS) || 20_000) {
    const anyLive = () => [...this.runtimes.values()].some((rt) => rt.locationId === locationId && rt.status === 'connected');
    if (anyLive()) return true;
    if (!this.hasPendingNumbers(locationId)) return false;
    return new Promise((resolve) => {
      const finish = (ok) => {
        clearTimeout(timer);
        this.off('status', onStatus);
        this.off('restore.progress', onProgress);
        resolve(ok);
      };
      const onStatus = (evt) => {
        if (evt.locationId === locationId && evt.status === 'connected') finish(true);
      };
      const onProgress = () => {
        if (anyLive()) finish(true);
        else if (!this.hasPendingNumbers(locationId)) finish(false);
      };
      const timer = setTimeout(() => finish(anyLive()), timeoutMs);
      this.on('status', onStatus);
      this.on('restore.progress', onProgress);
    });
  }

  /** Graceful shutdown: close sockets, keep links, release leases so another instance can take over. */
  async shutdown() {
    clearInterval(this._heartbeat);
    clearInterval(this._watchdog);
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
    // Re-read every connect so a changed proxyCountry applies on the next (re)connect.
    const proxyAgent = await this._resolveProxy(rt);
    if (rt.gen !== gen || rt.stopping) return; // torn down / superseded while we were awaiting

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      // Proxy (if configured): `agent` for the WebSocket, `fetchAgent` for media uploads.
      ...(proxyAgent ? { agent: proxyAgent, fetchAgent: proxyAgent } : {}),
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

    // Every handler is contained: a throw (sync or async) in one session is logged, counted
    // against that session's error budget, and never reaches Baileys or other sessions.
    const on = (event, fn) => {
      sock.ev.on(event, (payload) => {
        try {
          const out = fn(payload);
          if (out && typeof out.catch === 'function') out.catch((err) => this._recordError(rt, event, err));
        } catch (err) {
          this._recordError(rt, event, err);
        }
      });
    };

    on('creds.update', () => saveCreds().catch((err) => console.error(`[WA] saveCreds ${rt.id} failed: ${err.message}`)));

    on('connection.update', (update) => {
      if (rt.gen !== gen || rt.stopping) return undefined;
      return this._onConnectionUpdate(rt, sock, state, update);
    });

    on('messages.upsert', (payload) => {
      if (rt.gen !== gen) return;
      this._safeEmit(rt, 'messages.upsert', { session: this._sessionRef(rt), sock, ...payload });
    });

    on('messages.update', (updates) => {
      if (rt.gen !== gen) return;
      this._safeEmit(rt, 'messages.update', { session: this._sessionRef(rt), updates });
    });

    // Voice/video call signalling (offer → ringing → accept|reject|timeout → terminate).
    // Linked devices receive it but can't carry audio; the calls feature logs it to the CRM.
    on('call', (calls) => {
      if (rt.gen !== gen) return;
      this._safeEmit(rt, 'call', { session: this._sessionRef(rt), sock, calls });
    });
  }

  /** Pick this session's proxy (if any) → agent or null. Logs only masked URLs. */
  async _resolveProxy(rt) {
    rt.proxy = null;
    rt.proxyAgent = null;
    let country = '';
    try {
      const doc = await WaSession.findById(rt.id).select('settings.proxyCountry').lean();
      country = doc?.settings?.proxyCountry || '';
    } catch (err) {
      console.warn(`[WA] ${rt.id} could not read proxy setting (connecting directly): ${err.message}`);
      return null;
    }
    const picked = proxyPool.pickProxy(rt.id, country);
    if (!picked) return null;
    if (picked.missing) {
      console.warn(`[WA] ${rt.id} proxy country ${picked.country} has no proxies in PROXY_POOL_JSON — connecting directly`);
      return null;
    }
    try {
      const agent = proxyPool.createAgent(picked.url);
      rt.proxy = { country: picked.country, masked: picked.masked };
      rt.proxyAgent = agent;
      console.log(`[WA] ${rt.id} connecting via ${picked.country} proxy ${picked.masked}`);
      return agent;
    } catch (err) {
      console.warn(`[WA] ${rt.id} proxy ${picked.masked} unusable (connecting directly): ${err.message}`);
      return null;
    }
  }

  /** Emit to consumers without letting a listener's throw escape into Baileys. */
  _safeEmit(rt, event, payload) {
    try {
      this.emit(event, payload);
    } catch (err) {
      this._recordError(rt, `${event} listener`, err);
    }
  }

  /** Log + count a contained error; too many in the window pauses the session. */
  _recordError(rt, where, err) {
    console.error(`[WA] ${rt.id} ${where} handler error | ${formatError(err)}`);
    const now = Date.now();
    const log = (this._errorLog.get(rt.id) || []).filter((t) => now - t < ERROR_WINDOW_MS);
    log.push(now);
    this._errorLog.set(rt.id, log);
    // Only pause the runtime that is actually live — a late error from a superseded runtime
    // still counts, but must not tear down its replacement directly.
    if (log.length > ERROR_LIMIT && !rt.pausingForErrors && this.runtimes.get(rt.id) === rt) {
      rt.pausingForErrors = true;
      this._pauseForErrors(rt).catch((e) => console.error(`[WA] ${rt.id} pause-after-errors failed | ${formatError(e)}`));
    }
  }

  async _pauseForErrors(rt) {
    console.warn(`[WA] ${rt.id} paused: >${ERROR_LIMIT} errors in ${ERROR_WINDOW_MS / 60000} min`);
    await this._teardown(rt.id, { release: true });
    this._errorLog.delete(rt.id);
    await WaSession.updateOne(
      { _id: rt.id },
      { $set: { status: 'disconnected', lastError: PAUSED_FOR_ERRORS, ownerId: null, leaseUntil: null } },
    );
    this._emitStatus(rt.id, await WaSession.findById(rt.id).lean());
  }

  /**
   * Every 60s: restart (teardown + start) registered sessions that are stuck in 'connecting' for
   * over 2 min, or 'disconnected' with no reconnect timer pending. One number at a time; never
   * touches a session whose lease is held by another live instance.
   */
  async _runWatchdog() {
    if (this._watchdogBusy) return;
    this._watchdogBusy = true;
    try {
      const now = Date.now();
      const stuck = [];
      for (const rt of this.runtimes.values()) {
        if (rt.stopping || rt.pausingForErrors) continue;
        if (rt.status === 'connecting' && now - (rt.statusAt || now) > STUCK_CONNECTING_MS) stuck.push(rt);
        else if (rt.status === 'disconnected' && !rt.reconnectTimer) stuck.push(rt);
      }
      if (!stuck.length) return;
      const docs = await WaSession.find({ _id: { $in: stuck.map((r) => r.id) } })
        .select('_id registered isActive status ownerId leaseUntil')
        .lean();
      const byId = new Map(docs.map((d) => [String(d._id), d]));

      for (const rt of stuck) {
        // Re-check: state may have moved on while we awaited.
        if (this.runtimes.get(rt.id) !== rt || rt.stopping) continue;
        const doc = byId.get(rt.id);
        if (!doc || !doc.registered || !doc.isActive || doc.status === 'paused') continue;
        const leasedElsewhere = doc.ownerId && doc.ownerId !== this.instanceId && doc.leaseUntil && new Date(doc.leaseUntil).getTime() > Date.now();
        if (leasedElsewhere) {
          // Another instance owns it now — drop our dead runtime, don't fight for the lease.
          console.warn(`[WA] watchdog: ${rt.id} is leased by ${doc.ownerId} — dropping local runtime`);
          await this._teardown(rt.id);
          continue;
        }
        const why = rt.status === 'connecting' ? `stuck connecting ${Math.round((Date.now() - rt.statusAt) / 1000)}s` : 'disconnected with no retry pending';
        logger.warn('🩺 Watchdog restarting stuck number', { sessionId: rt.id, locationId: rt.locationId, reason: why });
        try {
          await this._teardown(rt.id);
          await this.start(rt.id, { fromWatchdog: true });
        } catch (err) {
          console.warn(`[WA] watchdog: restart ${rt.id} failed: ${err.message}`);
        }
      }
    } finally {
      this._watchdogBusy = false;
    }
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
      logger.info('🔗 WhatsApp number connected', { sessionId: rt.id, locationId: rt.locationId, phone });
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
      // Schedule before the (async) status write so the watchdog never sees 'disconnected' without a timer.
      clearTimeout(rt.reconnectTimer);
      rt.reconnectTimer = setTimeout(() => {
        rt.reconnectTimer = null;
        try {
          if (rt.stopping || this.runtimes.get(rt.id) !== rt) return;
          rt.status = 'connecting';
          rt.statusAt = Date.now();
          // On failure the runtime stays 'connecting' with no socket → the watchdog restarts it.
          this._connect(rt).catch((err) => this._recordError(rt, 'reconnect', err));
        } catch (err) {
          this._recordError(rt, 'reconnect', err);
        }
      }, delay);
      logger.warn('📴 Connection lost — reconnecting', { sessionId: rt.id, locationId: rt.locationId, code, attempt: rt.retries, inSeconds: Math.round(delay / 1000) });
      await this._setStatus(rt, 'disconnected', { lastError: `Connection lost (${code || 'network'}) — reconnecting.` });
    }
  }

  async _terminal(rt, status, lastError) {
    await this._teardown(rt.id, { release: true });
    await clearAuthState(rt.id);
    await WaSession.updateOne({ _id: rt.id }, { $set: { status, lastError, isActive: false, registered: false } });
    this._emitStatus(rt.id, await WaSession.findById(rt.id).lean());
    this.emit('session.closed', { session: this._sessionRef(rt), reason: status });
    logger.warn('⛔ Number disconnected permanently', { sessionId: rt.id, locationId: rt.locationId, status });
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
    rt.reconnectTimer = null;
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
    if (rt.status !== status) rt.statusAt = Date.now();
    rt.status = status;
    const doc = await WaSession.findOneAndUpdate({ _id: rt.id }, { $set: { status, ...patch } }, { new: true }).lean();
    this._emitStatus(rt.id, doc);
  }

  _emitStatus(id, doc) {
    if (!doc) return;
    const rt = this.runtimes.get(String(id));
    const payload = {
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
      // Reconnect attempt number while backing off (0 when connected / not retrying).
      reconnectAttempt: rt?.retries || 0,
    };
    try {
      this.emit('status', payload);
    } catch (err) {
      // A broken status listener (SSE, workflows) must not break the session's state machine.
      console.error(`[WA] ${id} status listener error | ${formatError(err)}`);
    }
  }
}

module.exports = SessionManager;
