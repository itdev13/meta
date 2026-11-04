const GroupsService = require('./groups.service');
const { ACTIONS } = require('../../workflows/trigger-keys');

function field(data, ...names) {
  for (const n of names) {
    const v = data?.[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/**
 * Feature: WhatsApp groups.
 *
 *   Inbound sync lives in whatsapp/inbound.service.js (per-number setting `syncGroups`); replies
 *   to a group contact route through messaging.service.js. This module adds:
 *
 *   GET  /api/locations/:locationId/groups?numberId=&refresh=1   group directory per number
 *   POST /api/locations/:locationId/groups/link { groupJid, numberId? }  create/ensure the CRM contact
 *   POST /workflows/actions/send-to-group  (key ACTIONS.SEND_TO_GROUP)
 *        data: { groupJid | groupName, message, mediaUrl?, numberId? } → { sent, groupJid, … }
 */
function register({ app, express, guards, workflowAction, services }) {
  const groups = new GroupsService(services);

  const router = express.Router({ mergeParams: true });
  router.use(guards.requireSession, guards.resolveLocation('locationId'));
  const wrap = (fn) => async (req, res, next) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };

  router.get(
    '/',
    wrap((req) => groups.list(req.locationId, { numberId: req.query.numberId || undefined, refresh: req.query.refresh === '1' || req.query.refresh === 'true' })),
  );
  router.post('/link', wrap((req) => groups.link(req.locationId, req.body || {})));

  // apiLimiter already runs on /api/locations/:locationId (core location router), so not again here.
  app.use('/api/locations/:locationId/groups', router);

  // ── Workflow action: send to a WhatsApp group ─────────────────────
  workflowAction('send-to-group', async (payload) => {
    const extras = payload?.extras || {};
    const data = payload?.data || payload?.inputData || {};
    const { locationId } = extras;
    if (!locationId) throw Object.assign(new Error('Missing locationId'), { statusCode: 400 });

    const text = field(data, 'message', 'text', 'body');
    const mediaUrl = field(data, 'mediaUrl', 'url', 'fileUrl');
    const numberId = field(data, 'numberId') || undefined;
    try {
      const target = await groups.resolveTarget(locationId, {
        groupJid: field(data, 'groupJid', 'groupId', 'jid'),
        groupName: field(data, 'groupName', 'group', 'name'),
        numberId,
      });
      const mapping = await services.contactService.findGroup(locationId, target.jid);
      const r = await services.messagingService.send({
        locationId,
        groupJid: target.jid,
        contactId: mapping?.ghlContactId || undefined,
        text,
        attachments: mediaUrl ? [mediaUrl] : [],
        source: 'workflow',
        mirror: !!mapping,
        preferredSessionId: numberId || target.sessionId || undefined,
        meta: { action: ACTIONS.SEND_TO_GROUP },
      });
      return {
        sent: true,
        groupJid: target.jid,
        groupName: target.subject || mapping?.groupSubject || '',
        contactId: mapping?.ghlContactId || '',
        whatsappMessageId: r.waMessageIds[0] || '',
        linkedNumber: r.session.phoneNumber || '',
      };
    } catch (err) {
      if (services.workflowsService?._failed) services.workflowsService._failed(locationId, extras.contactId || null, err, text).catch(() => {});
      throw err;
    }
  });
}

module.exports = { register };
