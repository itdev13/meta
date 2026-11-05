const mongoose = require('mongoose');
const WaSession = require('../../schemas/wa-session.schema');
const Installation = require('../../schemas/installation.schema');
const AgencySettings = require('../../schemas/agency-settings.schema');
const logger = require('../../utils/logger');
const { phoneToJid, digits } = require('../../whatsapp/jid');
const { escapeHtml } = require('../../auth/install-pages');
const { sendMail, configured: mailConfigured } = require('./mailer');
const { t, fill, CODES } = require('./i18n');

const MAX_EMAILS = 10;
const MAX_PHONES = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Per sub-account alert preferences. */
const AlertSettings =
  mongoose.models.AlertSettings ||
  mongoose.model(
    'AlertSettings',
    new mongoose.Schema(
      {
        locationId: { type: String, required: true, unique: true, index: true },
        companyId: { type: String, index: true },
        enabled: { type: Boolean, default: true },
        emails: { type: [String], default: [] },
        whatsappTo: { type: [String], default: [] }, // E.164 numbers alerted from another linked number
        language: { type: String, default: 'en' },
        notifyRecovery: { type: Boolean, default: true },
        copyAgency: { type: Boolean, default: true },
        updatedBy: { type: String, default: '' },
      },
      { collection: 'alert_settings', timestamps: true },
    ),
  );

const httpError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function minutesEnv(name, def) {
  const n = Number(process.env[name]);
  return (Number.isFinite(n) && n > 0 ? n : def) * 60_000;
}

/**
 * Disconnect alerts.
 *   logged_out / banned / replaced (session.closed) → alert right away
 *   disconnected → alert only if still down after ALERT_DISCONNECT_MINUTES (default 10)
 *   still down → reminder every ALERT_REMINDER_HOURS (default 24), at most 3 times
 *   connected again after an alert → "back online" (if notifyRecovery)
 * One open incident per number (WaSession.alert), claimed atomically so it's sent once.
 */
class AlertsService {
  constructor({ sessionManager }) {
    this.manager = sessionManager;
    this.graceMs = minutesEnv('ALERT_DISCONNECT_MINUTES', 10);
    this.reminderMs = (Number(process.env.ALERT_REMINDER_HOURS) > 0 ? Number(process.env.ALERT_REMINDER_HOURS) : 24) * 3_600_000;
    this.maxReminders = 3;
    this.bootAt = Date.now();
    this.timers = new Map();
  }

  start() {
    this.manager.on('session.closed', ({ session, reason }) => {
      this._clearTimer(session.id);
      setTimeout(() => this._open(session.id, reason).catch((e) => this._err('open', session.id, e)), 3000);
    });
    this.manager.on('status', (evt) => {
      if (evt.status === 'disconnected') {
        if (this.timers.has(evt.sessionId)) return;
        const timer = setTimeout(() => {
          this.timers.delete(evt.sessionId);
          this._checkStillDown(evt.sessionId).catch((e) => this._err('check', evt.sessionId, e));
        }, this.graceMs);
        timer.unref?.();
        this.timers.set(evt.sessionId, timer);
      } else if (evt.status === 'connected') {
        this._clearTimer(evt.sessionId);
        this._resolve(evt.sessionId).catch((e) => this._err('resolve', evt.sessionId, e));
      } else if (['paused', 'logged_out'].includes(evt.status)) {
        // A user-initiated pause / unlink isn't an outage: stop waiting and close any open incident.
        // (Involuntary logouts arrive right after via session.closed and reopen it.)
        this._clearTimer(evt.sessionId);
        WaSession.updateOne({ _id: evt.sessionId, 'alert.open': true }, { $set: { 'alert.open': false } }).catch(() => {});
      }
    });
    // Sweep: catches outages that started before a restart, and sends 24h reminders.
    const sweep = setInterval(() => this._sweep().catch((e) => this._err('sweep', '-', e)), 5 * 60_000);
    sweep.unref?.();
  }

  _clearTimer(id) {
    const timer = this.timers.get(String(id));
    if (timer) clearTimeout(timer);
    this.timers.delete(String(id));
  }

  _err(what, id, err) {
    logger.warn('🔔 Alert step failed', { step: what, sessionId: id, error: err.message });
  }

  async _checkStillDown(sessionId) {
    const doc = await WaSession.findById(sessionId).lean();
    if (!doc || !doc.isActive || doc.status !== 'disconnected') return;
    if (this.manager.isConnected(sessionId)) return;
    await this._open(sessionId, 'disconnected');
  }

  async _sweep() {
    // Give restored numbers time to come back after a deploy before judging them.
    if (Date.now() - this.bootAt < Math.max(this.graceMs, 15 * 60_000)) return;
    const cutoff = new Date(Date.now() - this.graceMs);
    const down = await WaSession.find({ status: 'disconnected', isActive: true, updatedAt: { $lt: cutoff }, 'alert.open': { $ne: true } })
      .select('_id')
      .limit(200)
      .lean();
    for (const d of down) await this._checkStillDown(String(d._id)).catch((e) => this._err('sweep-open', d._id, e));

    const remindBefore = new Date(Date.now() - this.reminderMs);
    const stale = await WaSession.find({ 'alert.open': true, 'alert.lastSentAt': { $lt: remindBefore }, 'alert.reminders': { $lt: this.maxReminders }, status: { $ne: 'connected' } })
      .select('_id status')
      .limit(200)
      .lean();
    for (const d of stale) {
      // Claim the reminder atomically so two sweeps never double-send.
      const claimed = await WaSession.findOneAndUpdate(
        { _id: d._id, 'alert.open': true, 'alert.lastSentAt': { $lt: remindBefore }, 'alert.reminders': { $lt: this.maxReminders } },
        { $set: { 'alert.lastSentAt': new Date() }, $inc: { 'alert.reminders': 1 } },
        { new: true },
      ).lean();
      if (claimed) await this._deliver(claimed, 'reminder', claimed.alert?.reason || d.status).catch((e) => this._err('remind', d._id, e));
    }
  }

  async _open(sessionId, reason) {
    const now = new Date();
    const doc = await WaSession.findOneAndUpdate(
      { _id: sessionId, 'alert.open': { $ne: true } },
      { $set: { alert: { open: true, reason, openedAt: now, lastSentAt: now, reminders: 0 } } },
      { new: true },
    ).lean();
    if (!doc) return; // already alerted for this outage
    logger.warn('🔔 Disconnect alert', { sessionId, locationId: doc.locationId, reason });
    await this._deliver(doc, 'down', reason);
  }

  async _resolve(sessionId) {
    const doc = await WaSession.findOneAndUpdate({ _id: sessionId, 'alert.open': true }, { $set: { 'alert.open': false } }, { new: false }).lean();
    if (!doc) return;
    const settings = await this.getSettings(doc.locationId);
    if (!settings.notifyRecovery) return;
    logger.info('🔔 Back-online alert', { sessionId, locationId: doc.locationId });
    await this._deliver({ ...doc, status: 'connected' }, 'back', doc.alert?.reason);
  }

  // ── Settings ──────────────────────────────────────────────

  async getSettings(locationId) {
    const row = await AlertSettings.findOne({ locationId }).lean();
    return {
      enabled: row?.enabled ?? true,
      emails: row?.emails || [],
      whatsappTo: row?.whatsappTo || [],
      language: row?.language || 'en',
      notifyRecovery: row?.notifyRecovery ?? true,
      copyAgency: row?.copyAgency ?? true,
    };
  }

  async view(locationId, companyId) {
    const [settings, agency, numbers] = await Promise.all([
      this.getSettings(locationId),
      companyId ? AgencySettings.findOne({ companyId }).select('alertEmails').lean() : null,
      WaSession.find({ locationId }).select('status').lean(),
    ]);
    return {
      settings,
      emailReady: mailConfigured(),
      agencyEmails: agency?.alertEmails?.length || 0,
      liveNumbers: numbers.filter((n) => n.status === 'connected').length,
      graceMinutes: Math.round(this.graceMs / 60_000),
      reminderHours: Math.round(this.reminderMs / 3_600_000),
    };
  }

  async update(locationId, companyId, patch, updatedBy) {
    const $set = { companyId, updatedBy };
    for (const k of ['enabled', 'notifyRecovery', 'copyAgency']) if (k in patch) $set[k] = !!patch[k];
    if ('language' in patch) {
      if (!CODES.includes(patch.language)) throw httpError('Unsupported language');
      $set.language = patch.language;
    }
    if ('emails' in patch) {
      const list = [...new Set((patch.emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
      const bad = list.find((e) => !EMAIL_RE.test(e) || e.length > 200);
      if (bad) throw httpError(`“${bad}” isn’t a valid email address`);
      if (list.length > MAX_EMAILS) throw httpError(`Up to ${MAX_EMAILS} email addresses`);
      $set.emails = list;
    }
    if ('whatsappTo' in patch) {
      const list = [...new Set((patch.whatsappTo || []).map((p) => digits(p)).filter(Boolean))];
      const bad = list.find((d) => d.length < 8 || d.length > 15);
      if (bad) throw httpError(`“${bad}” isn’t a valid phone number. Include the country code.`);
      if (list.length > MAX_PHONES) throw httpError(`Up to ${MAX_PHONES} WhatsApp numbers`);
      $set.whatsappTo = list.map((d) => `+${d}`);
    }
    await AlertSettings.updateOne({ locationId }, { $set, $setOnInsert: { locationId } }, { upsert: true });
    return this.view(locationId, companyId);
  }

  async sendTest(locationId) {
    const doc = await WaSession.findOne({ locationId }).sort({ isDefault: -1, index: 1 }).lean();
    const sample = doc || { _id: null, locationId, index: 1, label: '', phoneNumber: '', status: 'logged_out' };
    const result = await this._deliver({ ...sample, alert: { openedAt: new Date() } }, 'test', 'logged_out', { force: true });
    if (!result.email && !result.whatsapp) {
      throw httpError(result.why || 'Nothing was sent. Add an email address or WhatsApp number first.');
    }
    return result;
  }

  // ── Delivery ──────────────────────────────────────────────

  async _deliver(doc, kind, reason, { force = false } = {}) {
    const settings = await this.getSettings(doc.locationId);
    if (!settings.enabled && !force) return { skipped: 'disabled' };
    const install = await Installation.findOne({ locationId: doc.locationId }).select('locationName companyId').lean();
    const companyId = doc.companyId || install?.companyId;
    const agency = settings.copyAgency && companyId ? await AgencySettings.findOne({ companyId }).select('alertEmails').lean() : null;
    const emails = [...settings.emails, ...(agency?.alertEmails || [])];

    const L = t(settings.language);
    const account = install?.locationName || 'Sub-account';
    const numberName = `WhatsApp #${doc.index || '?'}${doc.label ? ` · ${doc.label}` : ''}`;
    const number = doc.phoneNumber ? `${numberName} (${doc.phoneNumber})` : numberName;
    const r = L.reason[reason] ? reason : 'disconnected';
    const vars = { account, number };
    const out = { email: 0, whatsapp: 0 };
    const why = [];

    if (emails.length) {
      if (!mailConfigured()) why.push('Email isn’t set up on the server yet.');
      else {
        try {
          const res = await sendMail({ to: emails, subject: fill(L.subject[kind], vars), ...this._email(L, kind, r, { account, number, since: doc.alert?.openedAt }) });
          out.email = res.sent || 0;
        } catch (err) {
          why.push(`Email failed: ${err.message}`);
          this._err('email', doc._id, err);
        }
      }
    }

    if (settings.whatsappTo.length) {
      const sender = await this._sender(doc);
      if (!sender) why.push('No other connected WhatsApp number to send the alert from.');
      else {
        const text = this._whatsappText(L, kind, r, vars);
        for (const phone of settings.whatsappTo) {
          if (doc.phoneNumber && digits(phone) === digits(doc.phoneNumber)) continue; // can't alert a number about itself
          try {
            await this.manager.sendRaw(sender, phoneToJid(phone), { text });
            out.whatsapp += 1;
          } catch (err) {
            this._err('whatsapp', doc._id, err);
          }
        }
      }
    }
    if (!emails.length && !settings.whatsappTo.length) why.push('No email addresses or WhatsApp numbers are set.');
    logger.info('🔔 Alert delivered', { locationId: doc.locationId, kind, reason: r, ...out });
    return { ...out, why: why.join(' ') };
  }

  /** Another connected number in the same sub-account (never the one that's down). */
  async _sender(doc) {
    const live = await WaSession.find({ locationId: doc.locationId, status: 'connected', _id: { $ne: doc._id } })
      .sort({ isDefault: -1, lastMessageAt: -1 })
      .select('_id')
      .lean();
    const hit = live.find((s) => this.manager.isConnected(String(s._id)));
    return hit ? String(hit._id) : null;
  }

  _whatsappText(L, kind, r, vars) {
    const head = `*${fill(L.subject[kind], vars)}*`;
    if (kind === 'back') return `${head}\n${L.backBody}`;
    if (kind === 'test') return `${head}\n${L.testBody}`;
    return `${head}\n${L.reason[r]}\n\n*${L.labels.fix}:* ${L.fix[r]}`;
  }

  _email(L, kind, r, { account, number, since }) {
    const ok = kind === 'back';
    const accent = ok ? '#10883f' : kind === 'test' ? '#2459d6' : '#c93636';
    const lead = ok ? L.backBody : kind === 'test' ? L.testBody : `${L.reason[r]} ${L.impact}`;
    const when = since ? new Date(since).toUTCString().replace(' GMT', ' UTC') : '';
    const rows = [
      [L.labels.account, account],
      [L.labels.number, number],
      ...(when && kind !== 'test' ? [[L.labels.since, when]] : []),
    ];
    const brand = escapeHtml(process.env.APP_NAME || 'Greenline');
    const html = `<!doctype html><html><body style="margin:0;background:#f5f6f4;font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#0e1b18">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e3e7e3;border-radius:16px;overflow:hidden">
<tr><td style="height:4px;background:${accent}"></td></tr>
<tr><td style="padding:26px 28px 8px">
<div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${accent}">${brand} · WhatsApp</div>
<h1 style="margin:8px 0 10px;font-size:21px;line-height:1.3">${escapeHtml(L.title[kind])}</h1>
<p style="margin:0;color:#3f4d4a;font-size:15px;line-height:1.6">${escapeHtml(lead)}</p>
</td></tr>
<tr><td style="padding:16px 28px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafbfa;border:1px solid #edf0ed;border-radius:12px">
${rows.map(([k, v]) => `<tr><td style="padding:10px 14px;color:#75827f;font-size:13px;width:110px">${escapeHtml(k)}</td><td style="padding:10px 14px;font-size:14px;font-weight:600">${escapeHtml(v)}</td></tr>`).join('')}
</table></td></tr>
${ok || kind === 'test' ? '' : `<tr><td style="padding:16px 28px 4px"><div style="font-size:13px;font-weight:700;margin-bottom:6px">${escapeHtml(L.labels.fix)}</div><div style="color:#3f4d4a;font-size:14px;line-height:1.6">${escapeHtml(L.fix[r])}</div></td></tr>`}
<tr><td style="padding:22px 28px 26px;color:#a3ada9;font-size:12px;line-height:1.6">${escapeHtml(L.footer)}</td></tr>
</table></td></tr></table></body></html>`;
    const text = [L.title[kind], '', lead, '', ...rows.map(([k, v]) => `${k}: ${v}`), ...(ok || kind === 'test' ? [] : ['', `${L.labels.fix}: ${L.fix[r]}`]), '', L.footer].join('\n');
    return { html, text };
  }
}

module.exports = { AlertsService, AlertSettings };
