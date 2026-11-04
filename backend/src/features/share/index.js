const { ShareService } = require('./share.service');
const { createShareRouter, createPublicConnectRouter } = require('./router');

/**
 * Share-to-connect: a secure, expiring link a CRM user sends to their client so the client can
 * link their WhatsApp from any device without a CRM login. The number lands in the sub-account.
 *
 *   api     POST|GET  /api/locations/:locationId/numbers/share       (create / list active)
 *           DELETE    /api/locations/:locationId/numbers/share/:id   (revoke)
 *   public  GET       /public/connect/:token                         (state; polled every ~2s)
 *           POST      /public/connect/:token/start   { method: 'qr'|'code', phone? }
 *           POST      /public/connect/:token/cancel
 */
function register({ app, guards, apiLimiter, services }) {
  const shareService = new ShareService({
    numbersService: services.numbersService,
    sessionManager: services.sessionManager,
    accessService: services.accessService,
    subscriptionService: services.subscriptionService,
    ghlService: services.ghlService,
  });

  const mw = apiLimiter ? [apiLimiter] : [];
  app.use('/api/locations/:locationId/numbers/share', ...mw, createShareRouter({ guards, shareService }));
  app.use('/public/connect', createPublicConnectRouter({ shareService }));

  services.shareService = shareService;
}

module.exports = { register };
