const WaSession = require('../schemas/wa-session.schema');
const Installation = require('../schemas/installation.schema');
const MessageLog = require('../schemas/message-log.schema');
const { fetchMedia } = require('../media/media.store');
const { phoneToJid, isPnJid, isGroupJid, toGroupJid } = require('./jid');
const hooks = require('../features/hooks');

const RECEIPT = { 3: 'delivered', 4: 'read', 5: 'read' };
const RANK = { pending: 0, sent: 1, delivered: 2, read: 3, failed: -1 };

function previewOf(text, kind) {
  if (text) return String(text).slice(0, 140);
  return kind === 'text' ? '' : `[${kind}]`;
}

function codedError(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

/**
 * Outbound delivery (CRM / workflow → WhatsApp), shared by the conversation-provider webhook
 * and workflow actions. Picks which linked number to use, resolves the recipient, builds the
 * Baileys payload, pushes it through the paced SendQueue and logs it.
 */
class MessagingService {
  constructor({ sessionManager, sendQueue, contactService, ghlService, accessService, subscriptionService }) {
    this.manager = sessionManager;
    this.queue = sendQueue;
    this.contacts = contactService;
    this.ghl = ghlService;
    this.access = accessService;
    this.subscription = subscriptionService;
  }

  /**
   * Choose the number to send from: explicit → the one the contact last wrote to → the
   * sub-account default → the most recently active connected number.
   */
  async pickSession(locationId, { preferredSessionId, mapping } = {}) {
    const connected = await WaSession.find({ locationId, isActive: true, status: 'connected' }).sort({ lastMessageAt: -1 }).lean();
    const live = connected.filter((s) => this.manager.isConnected(s._id));
    if (!live.length) {
      throw codedError('No WhatsApp number is connected for this sub-account. Link one in the WhatsApp app.', 'NO_NUMBER', 409);
    }
    const byId = (id) => id && live.find((s) => String(s._id) === String(id));
    if (preferredSessionId) {
      const s = byId(preferredSessionId);
      if (!s) throw codedError('The selected WhatsApp number is not connected.', 'NUMBER_OFFLINE', 409);
      return s;
    }
    return byId(mapping?.lastSessionId) || live.find((s) => s.isDefault) || live[0];
  }

  /**
   * Number to send to a WhatsApp group from (feature: groups): explicit → the number the group
   * last came through → any other connected number that is a member.
   */
  async pickGroupSession(locationId, groupJid, { preferredSessionId, mapping } = {}) {
    if (preferredSessionId) return this.pickSession(locationId, { preferredSessionId });
    const connected = await WaSession.find({ locationId, isActive: true, status: 'connected' }).sort({ lastMessageAt: -1 }).lean();
    const live = connected.filter((s) => this.manager.isConnected(s._id));
    if (!live.length) {
      throw codedError('No WhatsApp number is connected for this sub-account. Link one in the WhatsApp app.', 'NO_NUMBER', 409);
    }
    const last = mapping?.lastSessionId && live.find((s) => String(s._id) === String(mapping.lastSessionId));
    if (last) return last;
    const ordered = [...live.filter((s) => s.isDefault), ...live.filter((s) => !s.isDefault)];
    for (const s of ordered) {
      if (this.contacts.cachedGroupMeta?.(String(s._id), groupJid)) return s;
    }
    for (const s of ordered) {
      try {
        await this.contacts.groupMeta(this.manager.getSocket(s._id), String(s._id), groupJid);
        return s; // WhatsApp only answers group metadata for members
      } catch {
        /* not a member (or offline) — try the next number */
      }
    }
    throw codedError('None of the connected WhatsApp numbers is a member of this group.', 'NOT_IN_GROUP', 409);
  }

  async _recipient(session, { mapping, phone, groupJid }) {
    if (groupJid) return groupJid;
    if (mapping?.isGroup && mapping.waJid) return mapping.waJid; // group contact → the group jid
    if (mapping?.waJid) return mapping.waJid;
    if (mapping?.lidJid) return mapping.lidJid;
    const candidate = phoneToJid(phone);
    if (!candidate) throw codedError('This contact has no phone number to send WhatsApp to.', 'NO_PHONE');
    const hit = await this.manager.lookupNumber(session._id, phone);
    if (!hit.exists) throw codedError(`${phone} is not on WhatsApp.`, 'NOT_ON_WHATSAPP');
    return hit.jid || candidate;
  }

  async _buildMedia(url, caption) {
    const { buffer, mimeType, filename } = await fetchMedia(url);
    if (mimeType.startsWith('image/') && mimeType !== 'image/gif') {
      return { kind: 'image', content: { image: buffer, mimetype: mimeType, ...(caption ? { caption } : {}) } };
    }
    if (mimeType.startsWith('video/') || mimeType === 'image/gif') {
      return { kind: 'video', content: { video: buffer, mimetype: mimeType === 'image/gif' ? 'video/mp4' : mimeType, gifPlayback: mimeType === 'image/gif', ...(caption ? { caption } : {}) } };
    }
    if (mimeType.startsWith('audio/')) {
      return { kind: 'audio', content: { audio: buffer, mimetype: mimeType === 'audio/ogg' ? 'audio/ogg; codecs=opus' : mimeType, ptt: mimeType === 'audio/ogg' } };
    }
    return { kind: 'document', content: { document: buffer, mimetype: mimeType, fileName: filename, ...(caption ? { caption } : {}) } };
  }

  /**
   * Send to a GHL contact (or a raw phone). Returns { session, jid, waMessageIds }.
   *   source: 'ghl' (agent in Conversations) | 'workflow'
   *   mirror: also write the message into the GHL thread (workflow sends — GHL didn't create it)
   *   groupJid: (optional, feature: groups) send to this WhatsApp group instead of a person.
   *             A GHL contact whose mapping isGroup is also sent to its group automatically.
   */
  async send({ locationId, contactId, phone, text, attachments = [], source, ghlMessageId, preferredSessionId, mirror = false, bypassConsent = false, meta = {}, groupJid }) {
    await this.subscription.ensureEntitled(locationId);
    const ev = await this.access.ensureAllowed(locationId);

    const explicitGroup = groupJid ? toGroupJid(groupJid) : null;
    if (groupJid && !explicitGroup) throw codedError('That is not a valid WhatsApp group id.', 'GROUP_NOT_FOUND');
    let mapping = contactId ? await this.contacts.findByContact(locationId, contactId) : null;
    if (explicitGroup && !(mapping?.isGroup && mapping.waJid === explicitGroup)) mapping = await this.contacts.findGroup(locationId, explicitGroup);
    const targetGroup = explicitGroup || (mapping?.isGroup && isGroupJid(mapping.waJid) ? mapping.waJid : null);
    if (targetGroup) meta = { ...meta, isGroup: true, groupJid: targetGroup };

    let recipientPhone = phone;
    if (!targetGroup && !mapping && !recipientPhone && contactId) {
      const c = await this.ghl.getContact(locationId, contactId);
      recipientPhone = c?.phone;
    }

    const session = targetGroup
      ? await this.pickGroupSession(locationId, targetGroup, { preferredSessionId, mapping })
      : await this.pickSession(locationId, { preferredSessionId, mapping });
    const jid = await this._recipient(session, { mapping, phone: recipientPhone, groupJid: targetGroup });

    if (contactId && !mapping && isPnJid(jid)) {
      mapping = await this.contacts.linkOutbound({ locationId, ghlContactId: contactId, sessionId: String(session._id), pnJid: jid });
    }

    // Feature hooks: consent can block (throws), templates can rewrite ctx.text.
    const hookCtx = await hooks.beforeSend({ locationId, contactId, phone: recipientPhone, jid, text, attachments, source, session, mapping, bypassConsent, meta });
    text = hookCtx.text;

    const atts = (attachments || []).filter(Boolean);
    const parts = [];
    if (atts.length === 1 && text) {
      parts.push(await this._buildMedia(atts[0], text));
    } else {
      if (text) parts.push({ kind: 'text', content: { text } });
      for (const url of atts) parts.push(await this._buildMedia(url));
    }
    if (!parts.length) throw codedError('Nothing to send (empty message).', 'EMPTY');

    const waMessageIds = [];
    for (const [i, part] of parts.entries()) {
      const sent = await this.queue.enqueue(session, jid, part.content, ev.pace);
      const waMessageId = sent?.key?.id;
      if (waMessageId) waMessageIds.push(waMessageId);
      await MessageLog.create({
        locationId,
        companyId: session.companyId,
        sessionId: String(session._id),
        direction: 'outbound',
        source,
        isGroup: !!targetGroup,
        waJid: jid,
        waMessageId,
        // Only the first WA message carries the GHL id — receipts for it drive the GHL status.
        ghlMessageId: i === 0 ? ghlMessageId : undefined,
        ghlContactId: contactId,
        kind: part.kind,
        preview: previewOf(part.kind === 'text' ? text : i === 0 ? text : '', part.kind),
        status: 'sent',
      }).catch((err) => console.warn(`[Send] log failed: ${err.message}`));
    }

    if (mapping) await this.contacts.touchOutbound(mapping._id, String(session._id));

    if (mirror && contactId) {
      try {
        const inst = await Installation.findOne({ locationId }).select('conversationProviderId').lean();
        await this.ghl.addOutboundMessage(locationId, {
          conversationProviderId: inst?.conversationProviderId || process.env.GHL_CONVERSATION_PROVIDER_ID,
          contactId,
          ...(text ? { message: text } : {}),
          ...(atts.length ? { attachments: atts } : {}),
          altId: waMessageIds[0],
        });
      } catch (err) {
        console.warn(`[Send] GHL mirror failed (message was sent) for ${locationId}: ${err.message}`);
      }
    }

    hooks.afterSend({ ...hookCtx, text, waMessageIds }).catch(() => {});
    return { session, jid, waMessageIds };
  }

  /** WhatsApp delivery/read receipts → MessageLog + GHL message status. */
  async applyReceipts(session, updates) {
    for (const { key, update } of updates || []) {
      const next = RECEIPT[update?.status];
      if (!next || !key?.id || !key.fromMe) continue;
      const log = await MessageLog.findOne({ sessionId: session.id, waMessageId: key.id });
      if (!log || RANK[next] <= RANK[log.status]) continue;
      log.status = next;
      await log.save().catch(() => {});
      if (log.ghlMessageId && (log.source === 'ghl' || log.source === 'workflow')) {
        await this.ghl.updateMessageStatus(log.locationId, log.ghlMessageId, next);
      }
    }
  }
}

module.exports = MessagingService;
