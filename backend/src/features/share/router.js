const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const { ShareService } = require('./share.service');

/** CRM side: /api/locations/:locationId/numbers/share */
function createShareRouter({ guards, shareService }) {
  const router = Router({ mergeParams: true });
  router.use(guards.requireSession, guards.resolveLocation('locationId'));
  const wrap = (fn) => async (req, res, next) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };
  router.post('/', wrap((req) => shareService.create(req.auth, req.locationId, req.body || {})));
  router.get('/', wrap((req) => shareService.list(req.locationId)));
  router.delete('/:id', wrap((req) => shareService.revoke(req.auth, req.locationId, req.params.id)));
  return router;
}

/**
 * Client side (no auth): /public/connect/:token. The token itself is the credential.
 * Polling only — no SSE here. Reads allow a 2s poll with headroom; writes are tighter.
 */
function createPublicConnectRouter({ shareService }) {
  const router = Router();
  const tooMany = (req, res) =>
    res.status(429).json({ success: false, error: 'Too many requests — please wait a moment and try again.', code: 'RATE_LIMITED' });
  const readLimiter = rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false, handler: tooMany });
  const writeLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, handler: tooMany });

  router.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });

  const wrap = (fn) => async (req, res) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (err) {
      const { status, body } = ShareService.clientError(err);
      if (status >= 500) console.error(`[share] ${req.method} /public/connect | ${err.stack || err.message}`);
      res.status(status).json(body);
    }
  };

  router.get('/:token', readLimiter, wrap((req) => shareService.publicState(req.params.token)));
  router.post('/:token/start', writeLimiter, wrap((req) => shareService.start(req.params.token, req.body || {})));
  router.post('/:token/cancel', writeLimiter, wrap((req) => shareService.cancel(req.params.token)));
  return router;
}

module.exports = { createShareRouter, createPublicConnectRouter };
