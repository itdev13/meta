const { Router } = require('express');

/**
 * Consent API, mounted at /api/locations/:locationId/consent. Callable by the sub-account's own
 * session or by its agency (resolveLocation enforces both); both may change consent.
 */
function createConsentRouter({ guards, consentService }) {
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

  router.get('/settings', wrap((req) => consentService.getSettings(req.locationId)));
  router.put('/settings', wrap((req) => consentService.updateSettings(req.locationId, req.body || {}, req.auth)));

  router.get('/stats', wrap((req) => consentService.stats(req.locationId)));

  // ?status=opted_in|opted_out|unknown&q=<name or phone>&page=1&limit=25
  router.get('/contacts', wrap((req) => consentService.listContacts(req.locationId, req.query || {})));

  // :id = GHL contactId (or the consent record id for a number with no contact yet)
  router.get('/contacts/:id/log', wrap((req) => consentService.contactLog(req.locationId, req.params.id)));

  // { contactId | phone, status: 'opted_in' | 'opted_out', note } — note is required
  router.post('/manual', wrap((req) => consentService.manualChange(req.locationId, req.body || {}, req.auth)));

  // Full consent log as text/csv (the UI fetches it; downloads are blocked in the CRM iframe).
  router.get('/export.csv', async (req, res, next) => {
    try {
      await consentService.exportCsv(req.locationId, res);
    } catch (err) {
      if (res.headersSent) {
        console.warn(`[consent] export failed mid-stream for ${req.locationId}: ${err.message}`);
        res.end();
      } else next(err);
    }
  });

  return router;
}

module.exports = { createConsentRouter };
