const { AnalyticsService } = require('./analytics.service');

/**
 * Analytics feature — read-only, no hooks. Everything is derived from MessageLog.
 *
 *   GET /api/locations/:locationId/analytics?range=7d|30d|90d&sessionId=&tz=Area/City
 *   GET /api/agency/analytics?range=7d|30d|90d&tz=Area/City
 *
 * `tz` (IANA) buckets days and the hour-of-week heatmap; invalid or missing → UTC.
 * Both respond with the usual { success, data } envelope.
 */
function register({ app, guards }) {
  const service = new AnalyticsService();
  // No extra rate limiter: main.js already applies apiLimiter to /api/agency and
  // /api/locations/:locationId via app.use, which runs before these routes.

  const wrap = (fn) => async (req, res, next) => {
    try {
      res.set('Cache-Control', 'private, max-age=30');
      res.json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };

  app.get(
    '/api/locations/:locationId/analytics',
    guards.requireSession,
    guards.resolveLocation('locationId'),
    wrap((req) => service.location(req.locationId, req.query)),
  );

  app.get(
    '/api/agency/analytics',
    guards.requireSession,
    guards.requireAgency,
    wrap((req) => service.agency(req.auth.companyId, req.query)),
  );
}

module.exports = { register };
