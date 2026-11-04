const { downloadMediaMessage, normalizeMessageContent, getContentType } = require('@whiskeysockets/baileys');
const logger = require('../utils/logger');
const pino = require('pino');
const WaSession = require('../schemas/wa-session.schema');
const Installation = require('../schemas/installation.schema');
const MessageLog = require('../schemas/message-log.schema');
const { saveMedia } = require('../media/media.store');
const { normalizeJid, isPnJid, isLidJid, isGroupJid, isIgnorableJid, jidToPhone, digits } = require('./jid');
const { TRIGGERS } = require('../workflows/trigger-keys');
const hooks = require('../features/hooks');
const { formatError } = require('../utils/format-error');

const GHL_UPLOAD_MAX = 5 * 1024 * 1024;
const DOWNLOAD_MAX = 64 * 1024 * 1024;
const SKIP_TYPES = new Set(['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'keepInChatMessage', 'pinInChatMessage', 'encReactionMessage', 'pollUpdateMessage']);
const MEDIA_KIND = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document', stickerMessage: 'sticker', ptvMessage: 'video' };
const silent = pino({ level: 'silent' });

// feature: inbound controls — blacklist digits per cached session doc (docs are replaced on refresh).
const _blacklists = new WeakMap();
function blacklistOf(doc) {
  if (!doc) return null;
  if (_blacklists.has(doc)) return _blacklists.get(doc);
  const list = (doc.settings?.blacklist || []).map(digits).filter(Boolean);
  const set = list.length ? new Set(list) : null;
  _blacklists.set(doc, set);
  return set;
}

/** One concise line per dropped message (feature: inbound controls / groups). */
function logDrop(session, msg, reason, who) {
  console.debug(`[Inbound] drop ${reason} | ${session.id} ${msg?.key?.id || '?'}${who ? ` ${who}` : ''}`);
}

function vcardPhone(vcard) {
  const m = /TEL[^:]*:([+\d\s-]+)/i.exec(vcard || '');
  return m ? m[1].trim() : '';
}

/**
 * Turn a WhatsApp message into { kind, text, media } for the CRM thread.
 * Returns null for messages that aren't conversation content (receipts, key distribution…).
 */
function describe(message) {
  const content = normalizeMessageContent(message);
  if (!content) return null;
  const type = getContentType(content);
  if (!type || SKIP_TYPES.has(type)) return null;
  const m = content[type];

  if (MEDIA_KIND[type]) {
    return { kind: MEDIA_KIND[type], text: m?.caption || '', media: { type, node: m, fileName: m?.fileName, mimetype: m?.mimetype, size: Number(m?.fileLength || 0) } };
  }
  switch (type) {
    case 'conversation':
      return { kind: 'text', text: content.conversation };
    case 'extendedTextMessage':
      return { kind: 'text', text: m.text || '' };
    case 'locationMessage':
    case 'liveLocationMessage': {
      const label = [m.name, m.address].filter(Boolean).join(' — ');
      return { kind: 'location', text: `📍 ${label ? `${label}\n` : ''}https://maps.google.com/?q=${m.degreesLatitude},${m.degreesLongitude}` };
    }
    case 'contactMessage':
      return { kind: 'contact', text: `👤 ${m.displayName || 'Contact'} ${vcardPhone(m.vcard)}`.trim() };
    case 'contactsArrayMessage':
      return { kind: 'contact', text: (m.contacts || []).map((c) => `👤 ${c.displayName || 'Contact'} ${vcardPhone(c.vcard)}`.trim()).join('\n') };
    case 'reactionMessage':
      return m.text ? { kind: 'reaction', text: `Reacted ${m.text}` } : null;
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return { kind: 'other', text: `📊 Poll: ${m.name}\n${(m.options || []).map((o) => `• ${o.optionName}`).join('\n')}` };
    case 'buttonsResponseMessage':
      return { kind: 'text', text: m.selectedDisplayText || m.selectedButtonId || '' };
    case 'listResponseMessage':
      return { kind: 'text', text: m.title || m.singleSelectReply?.selectedRowId || '' };
    case 'templateButtonReplyMessage':
      return { kind: 'text', text: m.selectedDisplayText || '' };
    case 'interactiveResponseMessage':
      return { kind: 'text', text: m.body?.text || '' };
    case 'editedMessage': {
      const inner = describe(m.message);
      return inner ? { ...inner, text: `✏️ Edited: ${inner.text}` } : null;
    }
    default:
      return { kind: 'other', text: `[Unsupported WhatsApp message: ${type}]` };
  }
}

/**
 * WhatsApp → CRM. Customer messages become inbound messages on the contact's conversation;
 * replies the business typed on the phone are mirrored as outbound so the CRM thread is complete.
 */
class InboundService {
  constructor({ sessionManager, contactService, ghlService, messagingService, workflowsService }) {
    this.manager = sessionManager;
    this.contacts = contactService;
    this.ghl = ghlService;
    this.messaging = messagingService;
    this.workflows = workflowsService;
    this._sessionCache = new Map(); // id → { doc, at }

    // Number settings saved in the UI apply on the next message (no 30s cache lag).
    sessionManager.on('session.settings', ({ sessionId }) => this._sessionCache.delete(String(sessionId)));
    sessionManager.on('messages.upsert', (evt) => this.onUpsert(evt).catch((err) => console.error(`[Inbound] upsert failed | ${formatError(err)}`)));
    sessionManager.on('messages.update', ({ session, updates }) =>
      this.messaging.applyReceipts(session, updates).catch((err) => console.warn(`[Inbound] receipts failed: ${err.message}`)),
    );
    sessionManager.on('session.closed', ({ session, reason }) => {
      this.workflows
        .fireTrigger(TRIGGERS.NUMBER_DISCONNECTED, session.locationId, {
          locationId: session.locationId,
          sessionId: session.id,
          reason,
          timestamp: new Date().toISOString(),
        })
        .catch(() => {});
    });
  }

  async _session(id) {
    const hit = this._sessionCache.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.doc;
    const doc = await WaSession.findById(id).lean();
    this._sessionCache.set(id, { doc, at: Date.now() });
    return doc;
  }

  async _providerId(locationId) {
    const inst = await Installation.findOne({ locationId }).select('conversationProviderId').lean();
    return inst?.conversationProviderId || process.env.GHL_CONVERSATION_PROVIDER_ID;
  }

  async onUpsert({ session, sock, messages, type }) {
    if (type !== 'notify' && type !== 'append') return;
    const doc = await this._session(session.id);
    if (!doc || !doc.isActive) return;
    for (const msg of messages || []) {
      try {
        await this._handle(session, doc, sock, msg, type);
      } catch (err) {
        console.error(`[Inbound] ${session.id} message ${msg?.key?.id} failed | ${formatError(err)}`);
      }
    }
  }

  async _handle(session, doc, sock, msg, type) {
    const remoteJid = normalizeJid(msg?.key?.remoteJid);
    if (!remoteJid || isIgnorableJid(remoteJid)) return;
    // Groups: dropped unless the number has "Sync WhatsApp groups" on (feature: groups).
    if (isGroupJid(remoteJid)) {
      if (!doc.settings?.syncGroups) return;
      await this._handleGroup(session, doc, sock, msg, type, remoteJid);
      return;
    }
    // 'append' on a fresh link replays recent history — only take messages from the last 2 min.
    const ts = Number(msg.messageTimestamp || 0) * 1000;
    if (type === 'append' && ts && Date.now() - ts > 2 * 60 * 1000) return;

    const info = describe(msg.message);
    if (!info) return;

    const pnJid = isPnJid(remoteJid) ? remoteJid : normalizeJid(msg.key.senderPn || msg.key.remoteJidAlt) || null;
    const lidJid = isLidJid(remoteJid) ? remoteJid : normalizeJid(msg.key.senderLid) || null;
    const fromMe = !!msg.key.fromMe;
    // Inbound controls — all before MessageLog / GHL / triggers / hooks.
    if (doc.settings?.disableIncoming) return logDrop(session, msg, 'incoming_disabled');
    if (fromMe && doc.settings?.syncPhoneReplies === false) return;
    if (await this._blacklisted(session, doc, pnJid, lidJid)) return logDrop(session, msg, 'blacklisted', jidToPhone(pnJid) || lidJid);
    const noCreate = !!doc.settings?.doNotCreateContacts;
    const lookup = { locationId: session.locationId, sessionId: session.id, pnJid, lidJid, pushName: fromMe ? '' : msg.pushName };
    if (noCreate && !(await this.contacts.findExisting(lookup))) return logDrop(session, msg, 'unknown_contact', jidToPhone(pnJid) || lidJid);

    // Dedup FIRST — WhatsApp re-delivers on reconnect; the unique index makes this atomic.
    let log;
    try {
      log = await MessageLog.create({
        locationId: session.locationId,
        companyId: session.companyId,
        sessionId: session.id,
        direction: fromMe ? 'outbound' : 'inbound',
        source: fromMe ? 'phone' : 'contact',
        waJid: pnJid || lidJid,
        waMessageId: msg.key.id,
        kind: info.kind,
        preview: (info.text || `[${info.kind}]`).slice(0, 140),
        status: 'pending',
      });
    } catch (err) {
      if (err.code === 11000) return; // already processed (or it's our own API send)
      throw err;
    }

    const { mapping, created } = await this.contacts.resolveInbound({
      locationId: session.locationId,
      sessionId: session.id,
      linkedNumber: doc.phoneNumber,
      pnJid,
      lidJid,
      pushName: fromMe ? '' : msg.pushName,
    });

    const attachments = info.media ? await this._media(session, sock, msg, info, mapping.ghlContactId) : [];
    let text = info.text || '';
    if (info.media && !attachments.length) text = `${text ? `${text}\n` : ''}[${info.kind} could not be downloaded]`;

    const providerId = await this._providerId(session.locationId);
    const payload = {
      conversationProviderId: providerId,
      contactId: mapping.ghlContactId,
      ...(text ? { message: text } : {}),
      ...(attachments.length ? { attachments } : {}),
      altId: msg.key.id,
      ...(ts ? { date: new Date(ts).toISOString() } : {}),
    };

    let result;
    try {
      result = fromMe ? await this.ghl.addOutboundMessage(session.locationId, payload) : await this.ghl.addInboundMessage(session.locationId, payload);
    } catch (err) {
      if (!err.contactDeleted) throw err;
      // The GHL contact was deleted — forget the mapping, recreate once, retry.
      await this.contacts.drop(mapping._id);
      if (noCreate && !(await this.contacts.findExisting(lookup))) {
        await MessageLog.deleteOne({ _id: log._id }).catch(() => {});
        return logDrop(session, msg, 'unknown_contact', jidToPhone(pnJid) || lidJid);
      }
      const again = await this.contacts.resolveInbound({ locationId: session.locationId, sessionId: session.id, linkedNumber: doc.phoneNumber, pnJid, lidJid, pushName: msg.pushName });
      payload.contactId = again.mapping.ghlContactId;
      result = fromMe ? await this.ghl.addOutboundMessage(session.locationId, payload) : await this.ghl.addInboundMessage(session.locationId, payload);
    }

    await MessageLog.updateOne({ _id: log._id }, { $set: { ghlMessageId: result?.messageId, ghlContactId: payload.contactId, status: 'delivered' } });
    logger.info(fromMe ? '📲 Phone reply mirrored to CRM' : '📨 WhatsApp message synced to CRM', { locationId: session.locationId, sessionId: session.id, contactId: payload.contactId, kind: info.kind, attachments: attachments.length, created: !!created });
    if (!fromMe) {
      WaSession.updateOne({ _id: session.id }, { $inc: { 'stats.totalInbound': 1 }, $set: { lastMessageAt: new Date() } }).catch(() => {});
      if (doc.settings?.markRead) this.manager.readMessages(session.id, [msg.key]);
    }

    const base = {
      contactId: payload.contactId,
      locationId: session.locationId,
      messageText: text,
      messageType: info.kind,
      whatsappId: pnJid || lidJid,
      phone: mapping.phone || '',
      contactName: msg.pushName || mapping.pushName || '',
      linkedNumber: doc.phoneNumber || '',
      linkedNumberLabel: doc.label || '',
      attachmentUrl: attachments[0] || '',
      timestamp: new Date(ts || Date.now()).toISOString(),
    };
    if (fromMe) {
      this.workflows.fireTrigger(TRIGGERS.PHONE_REPLY, session.locationId, base).catch(() => {});
    } else {
      this.workflows.fireTrigger(TRIGGERS.MESSAGE_RECEIVED, session.locationId, base).catch(() => {});
      if (created) this.workflows.fireTrigger(TRIGGERS.NEW_CONTACT, session.locationId, base).catch(() => {});
      if (attachments.length) this.workflows.fireTrigger(TRIGGERS.MEDIA_RECEIVED, session.locationId, base).catch(() => {});
    }

    // Feature hooks (consent, keyword rules, auto-replies, analytics…). Never blocks the sync.
    hooks
      .afterInbound({
        session,
        sessionDoc: doc,
        msg,
        info,
        text,
        attachments,
        mapping,
        created,
        fromMe,
        isGroup: false,
        contactId: payload.contactId,
        ghlMessageId: result?.messageId,
        triggerPayload: base,
        handled: false,
      })
      .catch(() => {});
  }

  /**
   * feature: inbound controls — is this phone (pn jid, or the phone stored on the LID's mapping
   * when WhatsApp gave us no senderPn) on the number's blacklist?
   */
  async _blacklisted(session, doc, pnJid, lidJid) {
    const list = blacklistOf(doc);
    if (!list) return false;
    let phone = jidToPhone(pnJid);
    if (!phone && lidJid) {
      const known = await this.contacts.findByIdentity(session.locationId, { lidJid }).catch(() => null);
      phone = known?.phone || jidToPhone(known?.waJid);
    }
    return !!phone && list.has(digits(phone));
  }

  /** feature: groups — does this group sync on this number? (groupMode + per-group flag) */
  async _groupAllowed(session, doc, groupJid) {
    const flag = await this.contacts.groupFlag(session.locationId, groupJid);
    if (flag !== null) return flag;
    return doc.settings?.groupMode !== 'selected';
  }

  /** Group participant's phone for the blacklist, without network calls. */
  async _participantPhone(session, msg) {
    const participant = normalizeJid(msg.key.participant || msg.participant) || null;
    let pn = isPnJid(participant) ? participant : normalizeJid(msg.key.participantPn || msg.key.participantAlt || msg.participantPn) || null;
    if (!pn && isLidJid(participant)) {
      const meta = this.contacts.cachedGroupMeta(session.id, normalizeJid(msg.key.remoteJid));
      pn = meta?.lidToPn?.get(participant) || null;
      if (!pn) {
        const known = await this.contacts.findByIdentity(session.locationId, { lidJid: participant }).catch(() => null);
        return known?.phone || jidToPhone(known?.waJid) || '';
      }
    }
    return jidToPhone(pn);
  }

  // ── Groups (feature: groups) ──────────────────────────────────

  /** → { subject, meta } for a group; falls back to the stored subject when WhatsApp won't answer. */
  async _groupInfo(session, sock, groupJid) {
    try {
      const meta = await this.contacts.groupMeta(sock, session.id, groupJid);
      return { subject: meta.subject, meta };
    } catch (err) {
      console.warn(`[Inbound] groupMetadata ${groupJid} (${session.id}) failed: ${err.message}`);
      const existing = await this.contacts.findGroup(session.locationId, groupJid).catch(() => null);
      return { subject: existing?.groupSubject || '', meta: null };
    }
  }

  /** Who wrote a group message → { name, phone, waId }. Resolves LID participants where we can. */
  async _groupSender(session, doc, msg, meta) {
    const fromMe = !!msg.key.fromMe;
    const participant = normalizeJid(msg.key.participant || msg.participant) || null;
    let pn = isPnJid(participant) ? participant : normalizeJid(msg.key.participantPn || msg.key.participantAlt || msg.participantPn) || null;
    if (!pn && isLidJid(participant) && meta?.lidToPn?.get(participant)) pn = meta.lidToPn.get(participant);
    let known = null;
    if (!fromMe && (pn || isLidJid(participant))) {
      known = await this.contacts.findByIdentity(session.locationId, { pnJid: pn, lidJid: isLidJid(participant) ? participant : null }).catch(() => null);
      if (!pn && known?.waJid && isPnJid(known.waJid)) pn = known.waJid;
    }
    const phone = fromMe ? doc.phoneNumber || '' : jidToPhone(pn) || known?.phone || '';
    const name = fromMe ? doc.waName || 'You' : (msg.pushName || '').trim() || known?.pushName || phone || 'Someone';
    return { name, phone, waId: pn || participant || '' };
  }

  async _handleGroup(session, doc, sock, msg, type, groupJid) {
    const ts = Number(msg.messageTimestamp || 0) * 1000;
    if (type === 'append' && ts && Date.now() - ts > 2 * 60 * 1000) return;

    const info = describe(msg.message);
    if (!info) return;
    const fromMe = !!msg.key.fromMe;
    // Inbound controls + per-group enable — all before MessageLog / GHL / triggers / hooks.
    // (doNotCreateContacts does not apply: the group's own enable flag governs its contact.)
    if (doc.settings?.disableIncoming) return logDrop(session, msg, 'incoming_disabled', groupJid);
    if (fromMe && doc.settings?.syncPhoneReplies === false) return;
    if (!(await this._groupAllowed(session, doc, groupJid))) return logDrop(session, msg, 'group_disabled', groupJid);
    if (!fromMe && blacklistOf(doc)) {
      const phone = await this._participantPhone(session, msg);
      if (phone && blacklistOf(doc).has(digits(phone))) return logDrop(session, msg, 'blacklisted', `${phone} in ${groupJid}`);
    }

    let log;
    try {
      log = await MessageLog.create({
        locationId: session.locationId,
        companyId: session.companyId,
        sessionId: session.id,
        direction: fromMe ? 'outbound' : 'inbound',
        source: fromMe ? 'phone' : 'contact',
        isGroup: true,
        waJid: groupJid,
        waMessageId: msg.key.id,
        kind: info.kind,
        preview: (info.text || `[${info.kind}]`).slice(0, 140),
        status: 'pending',
      });
    } catch (err) {
      if (err.code === 11000) return;
      throw err;
    }

    const { subject, meta } = await this._groupInfo(session, sock, groupJid);
    const sender = await this._groupSender(session, doc, msg, meta);
    const resolve = () =>
      this.contacts.resolveGroup({ locationId: session.locationId, sessionId: session.id, linkedNumber: doc.phoneNumber, groupJid, subject, inbound: !fromMe });
    let { mapping, created } = await resolve();

    const attachments = info.media ? await this._media(session, sock, msg, info, mapping.ghlContactId) : [];
    let text = info.text || '';
    if (info.media && !attachments.length) text = `${text ? `${text}\n` : ''}[${info.kind} could not be downloaded]`;
    // Inbound: prefix with the sender so the CRM thread shows who said what. Phone replies are ours.
    const body = fromMe ? text : text ? `*${sender.name}*: ${text}` : `*${sender.name}*`;

    const providerId = await this._providerId(session.locationId);
    const payload = {
      conversationProviderId: providerId,
      contactId: mapping.ghlContactId,
      ...(body ? { message: body } : {}),
      ...(attachments.length ? { attachments } : {}),
      altId: msg.key.id,
      ...(ts ? { date: new Date(ts).toISOString() } : {}),
    };
    const post = () => (fromMe ? this.ghl.addOutboundMessage(session.locationId, payload) : this.ghl.addInboundMessage(session.locationId, payload));

    let result;
    try {
      result = await post();
    } catch (err) {
      if (!err.contactDeleted) throw err;
      await this.contacts.drop(mapping._id);
      ({ mapping, created } = await resolve());
      payload.contactId = mapping.ghlContactId;
      result = await post();
    }

    await MessageLog.updateOne({ _id: log._id }, { $set: { ghlMessageId: result?.messageId, ghlContactId: payload.contactId, status: 'delivered' } });
    logger.info(fromMe ? '📲 Group reply mirrored to CRM' : '👥 Group message synced to CRM', { locationId: session.locationId, sessionId: session.id, groupJid, contactId: payload.contactId, kind: info.kind });
    if (!fromMe) {
      WaSession.updateOne({ _id: session.id }, { $inc: { 'stats.totalInbound': 1 }, $set: { lastMessageAt: new Date() } }).catch(() => {});
      if (doc.settings?.markRead) this.manager.readMessages(session.id, [msg.key]);
    }

    const base = {
      contactId: payload.contactId,
      locationId: session.locationId,
      groupJid,
      groupName: subject || mapping.groupSubject || '',
      senderName: sender.name,
      senderPhone: sender.phone,
      senderWhatsappId: sender.waId,
      messageText: text,
      messageType: info.kind,
      linkedNumber: doc.phoneNumber || '',
      linkedNumberLabel: doc.label || '',
      attachmentUrl: attachments[0] || '',
      fromMe,
      timestamp: new Date(ts || Date.now()).toISOString(),
    };
    if (!fromMe) this.workflows.fireTrigger(TRIGGERS.GROUP_MESSAGE_RECEIVED, session.locationId, base).catch(() => {});

    // Same hook contract as 1:1; isGroup:true so 1:1 features (consent, rules…) can skip it.
    hooks
      .afterInbound({
        session,
        sessionDoc: doc,
        msg,
        info,
        text,
        attachments,
        mapping,
        created,
        fromMe,
        isGroup: true,
        contactId: payload.contactId,
        ghlMessageId: result?.messageId,
        triggerPayload: base,
        handled: false,
      })
      .catch(() => {});
  }

  async _media(session, sock, msg, info, contactId) {
    if (info.media.size && info.media.size > DOWNLOAD_MAX) return [];
    let buffer;
    try {
      const httpsAgent = this.manager.getProxyAgent ? this.manager.getProxyAgent(session.id) : undefined;
      buffer = await downloadMediaMessage(msg, 'buffer', httpsAgent ? { options: { httpsAgent } } : {}, { logger: silent, reuploadRequest: sock.updateMediaMessage });
    } catch (err) {
      console.warn(`[Inbound] media download failed (${session.id}): ${err.message}`);
      return [];
    }
    const mimeType = (info.media.mimetype || (info.kind === 'sticker' ? 'image/webp' : 'application/octet-stream')).split(';')[0];
    const filename = info.media.fileName || `whatsapp-${info.kind}-${msg.key.id}`;
    if (buffer.length <= GHL_UPLOAD_MAX) {
      try {
        const ext = filename.includes('.') ? '' : `.${(mimeType.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`;
        return [await this.ghl.uploadAttachment(session.locationId, { contactId, buffer, filename: `${filename}${ext}`, mimeType })];
      } catch (err) {
        console.warn(`[Inbound] GHL upload failed, serving from our media store: ${err.message}`);
      }
    }
    return [saveMedia(buffer, mimeType, filename).url];
  }
}

module.exports = { InboundService, describe };
