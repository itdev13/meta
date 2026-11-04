const { Router } = require('express');

/**
 * Mounted at /api/locations/:locationId/rules (session + location guarded). { success, data } envelope.
 *
 *   GET    /                     everything the panel needs: { rules, templates, settings, stats, hours }
 *   GET    /templates            POST /templates            PUT|DELETE /templates/:id
 *   POST   /templates/preview    { templateId | body, mediaUrl?, contactId? } → rendered text
 *   GET    /list                 POST /list (create)        PUT|DELETE /list/:id
 *   POST   /reorder              { ids: [...] }
 *   POST   /test                 { text, sessionId? } → which rule would fire
 *   GET|PUT /away                GET|PUT /welcome
 *   GET    /stats                hits per rule, last 30 days
 */
function createRulesRouter({ guards, rules }) {
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

  router.get(
    '/',
    wrap(async (req) => {
      const [list, templates, settings, stats, hours] = await Promise.all([
        rules.listRules(req.locationId),
        rules.listTemplates(req.locationId),
        rules.getSettings(req.locationId),
        rules.stats(req.locationId),
        rules.hoursStatus(req.locationId).catch(() => null),
      ]);
      return { rules: list, templates, settings, stats, hours };
    }),
  );

  // Templates
  router.get('/templates', wrap((req) => rules.listTemplates(req.locationId)));
  router.post('/templates/preview', wrap((req) => rules.preview(req.locationId, req.body || {})));
  router.post('/templates', wrap((req) => rules.createTemplate(req.auth, req.locationId, req.body || {})));
  router.put('/templates/:id', wrap((req) => rules.updateTemplate(req.locationId, req.params.id, req.body || {})));
  router.delete('/templates/:id', wrap((req) => rules.deleteTemplate(req.locationId, req.params.id)));

  // Keyword rules
  router.get('/list', wrap((req) => rules.listRules(req.locationId)));
  router.post('/list', wrap((req) => rules.createRule(req.locationId, req.body || {})));
  router.put('/list/:id', wrap((req) => rules.updateRule(req.locationId, req.params.id, req.body || {})));
  router.patch('/list/:id', wrap((req) => rules.updateRule(req.locationId, req.params.id, req.body || {})));
  router.delete('/list/:id', wrap((req) => rules.deleteRule(req.locationId, req.params.id)));
  router.post('/reorder', wrap((req) => rules.reorder(req.locationId, req.body?.ids)));
  router.post('/test', wrap((req) => rules.test(req.locationId, req.body || {})));

  // Away + welcome
  router.get('/away', wrap(async (req) => (await rules.getSettings(req.locationId)).away));
  router.put('/away', wrap((req) => rules.saveAway(req.locationId, req.body || {})));
  router.get('/welcome', wrap(async (req) => (await rules.getSettings(req.locationId)).welcome));
  router.put('/welcome', wrap((req) => rules.saveWelcome(req.locationId, req.body || {})));
  router.get('/hours', wrap((req) => rules.hoursStatus(req.locationId)));

  router.get('/stats', wrap((req) => rules.stats(req.locationId)));

  return router;
}

module.exports = { createRulesRouter };
