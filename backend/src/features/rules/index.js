const { RulesService } = require('./rules.service');
const { createRulesRouter } = require('./router');

/**
 * Feature: message templates, keyword rules ("Reply C to confirm"), away message / business
 * hours and welcome message.
 *
 *   routes   /api/locations/:locationId/rules/*
 *   hooks    afterInbound  → keyword rule → welcome → away
 *            beforeSend    → renders {{variables}} in any outbound text
 *   action   POST /workflows/actions/send-template  (ACTIONS.SEND_TEMPLATE)
 *   trigger  TRIGGERS.KEYWORD_RECEIVED
 */
function register({ app, guards, hooks, apiLimiter, workflowAction, services }) {
  const rules = new RulesService(services);

  const mw = [apiLimiter].filter(Boolean);
  app.use('/api/locations/:locationId/rules', ...mw, createRulesRouter({ guards, rules }));

  hooks.register('afterInbound', 'rules', (ctx) => rules.onInbound(ctx));
  hooks.register('beforeSend', 'rules-variables', (ctx) => rules.onBeforeSend(ctx));

  workflowAction('send-template', (payload) => rules.sendTemplateAction(payload));

  return rules;
}

module.exports = { register };
