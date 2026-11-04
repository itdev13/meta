const { Router } = require('express');
const { ACTIONS, TRIGGERS } = require('../workflows/trigger-keys');

/**
 * Sub-account API. Mounted at /api/locations/:locationId — callable by the sub-account's own
 * session OR by an agency session for one of its sub-accounts (resolveLocation enforces both).
 */
function createLocationRouter({ guards, numbersService, accessService, subscriptionService, workflowsService, messagingService }) {
  const router = Router({ mergeParams: true });
  router.use(guards.requireSession, guards.resolveLocation('locationId'));

  const wrap = (fn) => async (req, res, next) => {
    try {
      const data = await fn(req, res);
      if (!res.headersSent) res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  };

  // Everything the sub-account page needs in one round-trip.
  router.get(
    '/overview',
    wrap(async (req) => {
      const [access, numbers, stats, plans] = await Promise.all([
        accessService.evaluate(req.locationId),
        numbersService.list(req.locationId),
        numbersService.stats(req.locationId),
        subscriptionService.listPlans(req.locationId),
      ]);
      return { access, numbers, stats, plans };
    }),
  );

  router.get('/numbers', wrap((req) => numbersService.list(req.locationId)));
  router.post('/numbers', wrap((req) => numbersService.link(req.auth, req.locationId, req.body || {})));
  router.patch('/numbers/:id', wrap((req) => numbersService.update(req.auth, req.locationId, req.params.id, req.body || {})));
  router.post('/numbers/:id/relink', wrap((req) => numbersService.relink(req.auth, req.locationId, req.params.id, req.body || {})));
  router.post('/numbers/:id/resume', wrap((req) => numbersService.resume(req.auth, req.locationId, req.params.id)));
  router.post('/numbers/:id/pause', wrap((req) => numbersService.pause(req.auth, req.locationId, req.params.id)));
  router.post('/numbers/:id/cancel', wrap((req) => numbersService.cancel(req.auth, req.locationId, req.params.id)));
  router.delete('/numbers/:id', wrap((req) => numbersService.unlink(req.auth, req.locationId, req.params.id)));

  // Send a test message from a specific number (setup verification).
  router.post(
    '/numbers/:id/test',
    wrap(async (req) => {
      const { phone, text } = req.body || {};
      const r = await messagingService.send({
        locationId: req.locationId,
        phone,
        text: text || 'This is a test message from your WhatsApp connector ✅',
        source: 'ghl',
        preferredSessionId: req.params.id,
      });
      return { sent: true, to: phone, whatsappMessageId: r.waMessageIds[0] };
    }),
  );

  router.get('/activity', wrap((req) => numbersService.activity(req.locationId, req.query)));

  router.get('/subscription', wrap((req) => subscriptionService.getStatus(req.locationId)));
  router.get('/plans', wrap((req) => subscriptionService.listPlans(req.locationId)));

  router.get(
    '/automations',
    wrap(async (req) => ({ triggers: TRIGGERS, actions: ACTIONS, active: await workflowsService.listActive(req.locationId) })),
  );

  // Sub-account asks its agency to switch WhatsApp on.
  router.post(
    '/access-request',
    wrap(async (req) => {
      if (req.auth.scope !== 'location') {
        const err = new Error('Only a sub-account can request access');
        err.statusCode = 400;
        throw err;
      }
      return accessService.requestAccess(req.auth, req.body?.message);
    }),
  );

  return router;
}

module.exports = { createLocationRouter };
