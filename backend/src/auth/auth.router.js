const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const { formatError } = require('../utils/format-error');
const { renderInstallPage } = require('./install-pages');

const SCOPES = [
  'conversations.readonly',
  'conversations.write',
  'conversations/message.readonly',
  'conversations/message.write',
  'contacts.readonly',
  'contacts.write',
  'locations.readonly',
  'locations/customFields.readonly',
  'locations/customFields.write',
  'users.readonly',
  'oauth.readonly',
  'oauth.write',
  'marketplace-installer-details.readonly',
];

function createAuthRouter(authService, accessService) {
  const router = Router();
  const sessionLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

  // GET /auth/authorize — marketplace install entry (referral params carried in state).
  router.get('/authorize', (req, res) => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.GHL_CLIENT_ID,
      redirect_uri: process.env.GHL_REDIRECT_URI,
      scope: SCOPES.join(' '),
    });
    if (req.query.ref || req.query.campaign) {
      params.set('state', Buffer.from(JSON.stringify({ ref: req.query.ref, campaign: req.query.campaign })).toString('base64'));
    }
    res.redirect(`https://marketplace.gohighlevel.com/oauth/chooselocation?${params.toString()}`);
  });

  // GET /auth/callback
  router.get('/callback', async (req, res) => {
    if (!req.query.code) return res.send(renderInstallPage({ kind: 'success' }));
    try {
      const result = await authService.handleOAuthCallback(req.query.code);
      return res.send(renderInstallPage({ kind: 'success', agency: result.scope === 'company' }));
    } catch (error) {
      const reused =
        error.response?.data?.error === 'invalid_grant' || /authorization code/i.test(error.response?.data?.error_description || '');
      if (reused) return res.send(renderInstallPage({ kind: 'success', already: true }));
      console.error(`[Auth] OAuth callback failed | ${formatError(error)}`);
      // Never show internal errors (DB, stack details) to installers; they're in the server log.
      const ref = Date.now().toString(36).toUpperCase();
      console.error(`[Auth] install error ref ${ref}`);
      const ghlMsg = error.response?.data?.error_description || error.response?.data?.message;
      const message = ghlMsg ? `The CRM rejected the installation: ${ghlMsg}` : `Something went wrong on our side. Please try again in a minute. (Ref ${ref})`;
      return res.status(500).send(renderInstallPage({ kind: 'error', message }));
    }
  });

  /**
   * POST /auth/session { payload } — exchange the encrypted GHL user context for a session.
   * Returns the scope so the UI renders the agency console or the sub-account page.
   */
  router.post('/session', sessionLimiter, async (req, res) => {
    const { payload } = req.body || {};
    if (!payload || typeof payload !== 'string') {
      return res.status(400).json({ success: false, error: 'payload is required' });
    }
    try {
      const userData = authService.decryptSsoPayload(payload);
      const claims = authService.claimsFromUserData(userData);
      const context = await accessService.describeContext(claims);
      return res.json({ success: true, data: { token: authService.signSession(claims), user: claims, context } });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  // POST /auth/dev { scope, companyId, locationId } — local development only.
  router.post('/dev', async (req, res) => {
    if (process.env.ALLOW_DEV_LOGIN !== 'true') return res.status(404).json({ success: false, error: 'Not found' });
    const { scope = 'location', companyId = 'dev_company', locationId = 'dev_location' } = req.body || {};
    const claims = {
      userId: 'dev_user',
      companyId,
      name: 'Dev User',
      email: 'dev@example.com',
      role: 'admin',
      userType: scope === 'agency' ? 'agency' : 'account',
      scope,
      locationId: scope === 'location' ? locationId : null,
    };
    const context = await accessService.describeContext(claims);
    return res.json({ success: true, data: { token: authService.signSession(claims), user: claims, context } });
  });

  return router;
}

module.exports = { createAuthRouter, SCOPES };
