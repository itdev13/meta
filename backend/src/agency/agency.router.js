const { Router } = require('express');

/**
 * Agency console API, mounted at /api/agency. Reads need an agency session; anything that
 * changes policy needs an agency ADMIN. Per-sub-account number management goes through the
 * location router (/api/locations/:id/...) which accepts agency sessions for owned sub-accounts.
 */
function createAgencyRouter({ guards, agencyService, accessService }) {
  const router = Router();
  router.use(guards.requireSession, guards.requireAgency);

  const wrap = (fn) => async (req, res, next) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };
  const who = (req) => req.auth.email || req.auth.userId;

  router.get('/overview', wrap((req) => agencyService.overview(req.auth.companyId, { refresh: req.query.refresh === '1' })));

  router.get('/settings', wrap((req) => accessService.getSettings(req.auth.companyId)));
  router.put('/settings', guards.requireAgencyAdmin, wrap((req) => agencyService.updateSettings(req.auth.companyId, req.body || {}, who(req))));

  router.patch(
    '/sub-accounts/:locationId/access',
    guards.requireAgencyAdmin,
    guards.resolveLocation('locationId'),
    wrap((req) => agencyService.setAccess(req.auth.companyId, req.locationId, req.body || {}, who(req))),
  );

  router.post(
    '/sub-accounts/:locationId/decline',
    guards.requireAgencyAdmin,
    guards.resolveLocation('locationId'),
    wrap((req) => agencyService.declineRequest(req.auth.companyId, req.locationId, who(req))),
  );

  router.post(
    '/sub-accounts/bulk-access',
    guards.requireAgencyAdmin,
    wrap((req) => {
      const { locationIds, enabled } = req.body || {};
      if (!Array.isArray(locationIds) || typeof enabled !== 'boolean') {
        throw Object.assign(new Error('locationIds[] and enabled:boolean are required'), { statusCode: 400 });
      }
      return agencyService.bulkAccess(req.auth.companyId, locationIds, enabled, who(req));
    }),
  );

  return router;
}

module.exports = { createAgencyRouter };
