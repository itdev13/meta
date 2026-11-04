const { ConsentService } = require('./consent.service');
const { createConsentRouter } = require('./consent.router');

/**
 * Consent & compliance feature: opt-in / one-tap unsubscribe / consent log.
 *
 *   hooks      afterInbound 'consent' (STOP / START keywords, implicit opt-in; sets ctx.handled)
 *              beforeSend   'consent' (throws OPTED_OUT 409 unless ctx.bypassConsent)
 *   actions    POST /workflows/actions/opt-in-contact, /workflows/actions/opt-out-contact
 *   api        /api/locations/:locationId/consent/*
 *
 * Loads first in features/index.js ORDER so a STOP is consumed before keyword auto-replies.
 */
function register({ app, guards, hooks, apiLimiter, workflowAction, services }) {
  const consentService = new ConsentService({
    ghlService: services.ghlService,
    workflowsService: services.workflowsService,
    messagingService: services.messagingService,
  });

  hooks.register('afterInbound', 'consent', (ctx) => consentService.onInbound(ctx));
  hooks.register('beforeSend', 'consent', (ctx) => consentService.onBeforeSend(ctx));

  workflowAction('opt-in-contact', (payload) => consentService.workflowChange(payload, 'opted_in'));
  workflowAction('opt-out-contact', (payload) => consentService.workflowChange(payload, 'opted_out'));

  const mw = apiLimiter ? [apiLimiter] : [];
  app.use('/api/locations/:locationId/consent', ...mw, createConsentRouter({ guards, consentService }));

  // Exposed for other features (e.g. broadcasts can pre-filter opted-out recipients).
  services.consentService = consentService;
}

module.exports = { register };
