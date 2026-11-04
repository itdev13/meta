const { Router } = require('express');
const { toGhlActionMessage } = require('./action-errors');
const { ghlSignatureGuard } = require('../webhooks/ghl-signature');

/**
 * GHL Workflows endpoints. All are server-to-server calls from GHL → signature guarded.
 * Action failures return 400 + a human message so the workflow step shows why it failed.
 */
function createWorkflowsRouter(workflowsService) {
  const router = Router();

  router.get('/health', (req, res) => res.json({ status: 'ok', module: 'workflows' }));

  router.post('/triggers/subscriptions', ghlSignatureGuard, async (req, res) => {
    try {
      res.json(await workflowsService.handleSubscription(req.body));
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  const action = (name, fn) => router.post(`/actions/${name}`, ghlSignatureGuard, workflowActionHandler(name, fn));

  action('send-message', (p) => workflowsService.sendMessage(p));
  action('send-media', (p) => workflowsService.sendMedia(p));
  action('send-to-number', (p) => workflowsService.sendToNumber(p));
  action('check-number', (p) => workflowsService.checkNumber(p));

  return router;
}

/**
 * Express handler for a GHL workflow action. fn(payload) → data object. Failures → 400 with a
 * human message GHL shows in the execution history. Exported so feature modules can register
 * their own actions with identical behaviour.
 */
function workflowActionHandler(name, fn) {
  return async (req, res) => {
    try {
      const data = await fn(req.body);
      res.json({ success: true, data, ...data });
    } catch (error) {
      const message = toGhlActionMessage(error);
      console.warn(`[Action:${name}] ${req.body?.extras?.locationId} failed: ${error.code || ''} ${error.message}`);
      res.status(400).json({ success: false, message, error: message });
    }
  };
}

module.exports = { createWorkflowsRouter, workflowActionHandler };
