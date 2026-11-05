const { Router } = require('express');
const { AlertsService } = require('./alerts.service');
const { LANGUAGES } = require('./i18n');

/**
 * Feature: disconnect alerts — email and/or WhatsApp when a number disconnects, logs out,
 * is banned or replaced; reminders while it stays down; "back online" when it recovers.
 *
 *   GET  /api/locations/:locationId/alerts        → { settings, emailReady, agencyEmails, liveNumbers, languages, … }
 *   PUT  /api/locations/:locationId/alerts        { enabled, emails, whatsappTo, language, notifyRecovery, copyAgency }
 *   POST /api/locations/:locationId/alerts/test   → sends a test alert to the saved recipients
 *
 * Agency-wide copies: AgencySettings.alertEmails (PUT /api/agency/settings).
 */
function register({ app, guards, apiLimiter, services }) {
  const alerts = new AlertsService({ sessionManager: services.sessionManager });
  alerts.start();

  const router = Router({ mergeParams: true });
  router.use(guards.requireSession, guards.resolveLocation('locationId'));
  const wrap = (fn) => async (req, res, next) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };
  const withLangs = (v) => ({ ...v, languages: LANGUAGES });

  const lastTest = new Map(); // locationId → ms
  router.get('/', wrap(async (req) => withLangs(await alerts.view(req.locationId, req.auth.companyId))));
  router.put('/', wrap(async (req) => withLangs(await alerts.update(req.locationId, req.auth.companyId, req.body || {}, req.auth.userId || ''))));
  router.post(
    '/test',
    wrap(async (req) => {
      const prev = lastTest.get(req.locationId) || 0;
      if (Date.now() - prev < 60_000) throw Object.assign(new Error('Please wait a minute before sending another test.'), { statusCode: 429 });
      lastTest.set(req.locationId, Date.now());
      return alerts.sendTest(req.locationId);
    }),
  );

  app.use('/api/locations/:locationId/alerts', ...(apiLimiter ? [apiLimiter] : []), router);
  services.alertsService = alerts;
}

module.exports = { register };
