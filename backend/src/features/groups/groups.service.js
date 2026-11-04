const WaSession = require('../../schemas/wa-session.schema');
const ContactMapping = require('../../schemas/contact-mapping.schema');
const { normalizeJid, toGroupJid } = require('../../whatsapp/jid');

const DIRECTORY_TTL_MS = 5 * 60 * 1000;

function httpError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** Effective per-group sync state: explicit flag wins, else 'all' → on, 'selected' → off. */
function effectiveEnabled(groupMode, explicit) {
  if (explicit === true || explicit === false) return explicit;
  return groupMode !== 'selected';
}

/**
 * WhatsApp group directory + linking (feature: groups).
 *
 * The directory comes from sock.groupFetchAllParticipating() per connected number, cached a few
 * minutes in memory (WhatsApp rate-limits that query). Linking a group creates/ensures its single
 * GHL contact ("👥 <subject>", tag whatsapp-group) through ContactService.resolveGroup.
 */
class GroupsService {
  constructor({ sessionManager, contactService, messagingService, workflowsService, subscriptionService, accessService }) {
    this.manager = sessionManager;
    this.subscription = subscriptionService;
    this.access = accessService;
    this.contacts = contactService;
    this.messaging = messagingService;
    this.workflows = workflowsService;
    this._dir = new Map(); // sessionId → { at, groups: [slim meta…], ownIds }
  }

  async _sessions(locationId, numberId) {
    const q = { locationId };
    if (numberId) q._id = numberId;
    const docs = await WaSession.find(q).sort({ isDefault: -1, createdAt: 1 }).lean().catch((err) => {
      if (err.name === 'CastError') throw httpError('Number not found', 404, 'NOT_FOUND');
      throw err;
    });
    if (numberId && !docs.length) throw httpError('Number not found', 404, 'NOT_FOUND');
    return docs;
  }

  /** All groups one connected number participates in → [{ jid, subject, size, announce, isAdmin, … }]. */
  async _directory(sessionId, { refresh = false } = {}) {
    const id = String(sessionId);
    const hit = this._dir.get(id);
    if (!refresh && hit && Date.now() - hit.at < DIRECTORY_TTL_MS) return hit.groups;
    const sock = this.manager.getSocket(id);
    const own = new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map((j) => normalizeJid(j)));
    const all = (await sock.groupFetchAllParticipating()) || {};
    const groups = [];
    for (const meta of Object.values(all)) {
      const jid = normalizeJid(meta?.id);
      if (!jid) continue;
      this.contacts.primeGroupMeta(id, jid, meta);
      const me = (meta.participants || []).find((p) => [p.id, p.jid, p.lid].filter(Boolean).some((x) => own.has(normalizeJid(x))));
      groups.push({
        jid,
        subject: String(meta.subject || '').trim(),
        size: Number(meta.size || meta.participants?.length || 0),
        announce: !!meta.announce,
        isAdmin: !!me?.admin,
        createdAt: meta.creation ? new Date(Number(meta.creation) * 1000).toISOString() : null,
      });
    }
    groups.sort((a, b) => a.subject.localeCompare(b.subject, undefined, { sensitivity: 'base' }));
    this._dir.set(id, { at: Date.now(), groups });
    return groups;
  }

  /**
   * GET /groups → { numbers: [{ numberId, phoneNumber, label, connected, syncGroups, groupMode, groups, error }] }.
   * Each group carries { mapped, contactId, lastActivityAt } from ContactMapping, plus
   * explicit (true|false|null — the stored per-group flag) and enabled (effective for this
   * number's groupMode: 'all' → !== false, 'selected' → === true; independent of syncGroups).
   */
  async list(locationId, { numberId, refresh = false } = {}) {
    const sessions = await this._sessions(locationId, numberId);
    const mappings = await ContactMapping.find({ locationId, isGroup: true }).select('waJid ghlContactId lastSessionId lastInboundAt lastOutboundAt groupSubject groupEnabled').lean();
    const byJid = new Map(mappings.map((m) => [m.waJid, m]));

    const numbers = [];
    for (const s of sessions) {
      const connected = this.manager.isConnected(s._id);
      const row = {
        numberId: String(s._id),
        phoneNumber: s.phoneNumber || null,
        label: s.label || '',
        connected,
        syncGroups: !!s.settings?.syncGroups,
        groupMode: s.settings?.groupMode === 'selected' ? 'selected' : 'all',
        groups: [],
        error: '',
      };
      if (connected) {
        try {
          const groups = await this._directory(s._id, { refresh });
          row.groups = groups.map((g) => {
            const m = byJid.get(g.jid);
            const explicit = typeof m?.groupEnabled === 'boolean' ? m.groupEnabled : null;
            return {
              ...g,
              mapped: !!m?.ghlContactId,
              contactId: m?.ghlContactId || null,
              explicit,
              enabled: effectiveEnabled(row.groupMode, explicit),
              lastActivityAt: m ? [m.lastInboundAt, m.lastOutboundAt].filter(Boolean).sort().pop() || null : null,
            };
          });
        } catch (err) {
          console.warn(`[Groups] directory ${s._id} failed: ${err.message}`);
          row.error = err.code === 'NUMBER_OFFLINE' ? 'This number is offline.' : 'WhatsApp didn’t return the group list. Try again in a minute.';
        }
      } else {
        row.error = 'Connect this number to see its groups.';
      }
      numbers.push(row);
    }
    return { numbers };
  }

  /** POST /groups/link { groupJid, numberId? } → create/ensure the group's GHL contact now. */
  async link(locationId, { groupJid, numberId } = {}) {
    const jid = toGroupJid(groupJid);
    if (!jid) throw httpError('A valid WhatsApp group id is required.', 400, 'BAD_GROUP');
    await this.subscription.ensureEntitled(locationId);
    await this.access.ensureAllowed(locationId);

    const session = await this.messaging.pickGroupSession(locationId, jid, {
      preferredSessionId: numberId || undefined,
      mapping: await this.contacts.findGroup(locationId, jid),
    });
    const sock = this.manager.getSocket(session._id);
    let meta;
    try {
      meta = await this.contacts.groupMeta(sock, String(session._id), jid, { force: true });
    } catch {
      throw httpError('This number is not a member of that group.', 409, 'NOT_IN_GROUP');
    }
    const { mapping, created } = await this.contacts.resolveGroup({
      locationId,
      sessionId: String(session._id),
      linkedNumber: session.phoneNumber,
      groupJid: jid,
      subject: meta.subject,
      inbound: false,
    });
    return { jid, subject: meta.subject, size: meta.size, contactId: mapping.ghlContactId, numberId: String(session._id), created, mapped: true };
  }

  /**
   * POST /groups/toggle { numberId, groupJid, enabled } → { groupJid, enabled }.
   * Stores the flag on the group's ContactMapping (location-wide, shared by every number in the
   * group). No GHL contact is created: if the group has never synced, a contact-less placeholder
   * row carries the flag and the contact is created on its first synced message.
   */
  async toggle(locationId, { numberId, groupJid, enabled } = {}) {
    const jid = toGroupJid(groupJid);
    if (!jid) throw httpError('A valid WhatsApp group id is required.', 400, 'BAD_GROUP');
    if (typeof enabled !== 'boolean') throw httpError('enabled must be true or false.', 400, 'BAD_REQUEST');
    let sessionId = '';
    if (numberId) sessionId = String((await this._sessions(locationId, numberId))[0]._id);
    const subject = (sessionId && this.contacts.cachedGroupMeta(sessionId, jid)?.subject) || this._dirSubject(jid);
    const value = await this.contacts.setGroupFlag(locationId, jid, enabled, { sessionId, subject });
    return { groupJid: jid, enabled: value };
  }

  _dirSubject(jid) {
    for (const { groups } of this._dir.values()) {
      const hit = groups.find((g) => g.jid === jid);
      if (hit) return hit.subject;
    }
    return '';
  }

  /**
   * Find a group by jid or by (case-insensitive) name among the location's connected numbers.
   * → { jid, subject, sessionId } — sessionId is a number that is a member.
   */
  async resolveTarget(locationId, { groupJid, groupName, numberId }) {
    const jid = toGroupJid(groupJid);
    if (jid) return { jid, subject: '', sessionId: numberId || null };
    const name = String(groupName || '').trim().toLowerCase();
    if (!name) throw httpError('Enter a group id or a group name.', 400, 'GROUP_NOT_FOUND');

    const sessions = (await this._sessions(locationId, numberId || undefined)).filter((s) => this.manager.isConnected(s._id));
    if (!sessions.length) {
      throw httpError('No WhatsApp number is connected for this sub-account. Link one in the WhatsApp app.', 409, numberId ? 'NUMBER_OFFLINE' : 'NO_NUMBER');
    }
    for (const s of sessions) {
      let groups = [];
      try {
        groups = await this._directory(s._id);
      } catch {
        continue;
      }
      const hit = groups.find((g) => g.subject.toLowerCase() === name);
      if (hit) return { jid: hit.jid, subject: hit.subject, sessionId: String(s._id) };
    }
    // Fallback: a group already linked to the CRM under that name (directory may be rate-limited).
    const esc = String(groupName).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mapped = await ContactMapping.findOne({ locationId, isGroup: true, groupSubject: new RegExp(`^${esc}$`, 'i') }).lean();
    if (mapped) return { jid: mapped.waJid, subject: mapped.groupSubject, sessionId: numberId || null };
    throw httpError(`No WhatsApp group named “${String(groupName).trim()}” was found on the connected numbers.`, 404, 'GROUP_NOT_FOUND');
  }
}

module.exports = GroupsService;
module.exports.effectiveEnabled = effectiveEnabled;
