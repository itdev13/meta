const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Structured logging (winston, ConvoVault style). Legacy console.* calls are routed through it.
const logger = require('./utils/logger');

logger.bridgeConsole();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { connectDatabase } = require('./database/connection');
const { formatError } = require('./utils/format-error');

const CryptoService = require('./crypto/crypto.service');
const AuthService = require('./auth/auth.service');
const GhlService = require('./ghl/ghl.service');
const SubscriptionService = require('./subscription/subscription.service');
const AccessService = require('./access/access.service');
const SessionManager = require('./whatsapp/session-manager');
const SendQueue = require('./whatsapp/send-queue');
const ContactService = require('./whatsapp/contact.service');
const MessagingService = require('./whatsapp/messaging.service');
const { InboundService } = require('./whatsapp/inbound.service');
const WorkflowsService = require('./workflows/workflows.service');
const NumbersService = require('./sessions/numbers.service');
const AgencyService = require('./agency/agency.service');

const { createSessionGuards } = require('./auth/session.middleware');
const { createAuthRouter } = require('./auth/auth.router');
const { createLocationRouter } = require('./sessions/location.router');
const { createAgencyRouter } = require('./agency/agency.router');
const { createLiveRouter } = require('./sessions/live.router');
const { createWebhooksRouter } = require('./webhooks/webhooks.router');
const { createWorkflowsRouter, workflowActionHandler } = require('./workflows/workflows.router');
const { ghlSignatureGuard } = require('./webhooks/ghl-signature');
const { loadFeatures } = require('./features');
const hooks = require('./features/hooks');
const { createMediaRouter, cleanupExpiredMedia } = require('./media/media.store');

async function bootstrap() {
  await connectDatabase();

  // ── Services ────────────────────────────────────────────────
  const crypto = new CryptoService();
  const authService = new AuthService(crypto);
  const ghlService = new GhlService(authService);
  const subscriptionService = new SubscriptionService();
  const accessService = new AccessService(subscriptionService, authService);
  const sessionManager = new SessionManager(crypto);
  const sendQueue = new SendQueue(sessionManager);
  const contactService = new ContactService(ghlService);
  const workflowsService = new WorkflowsService(authService);
  const messagingService = new MessagingService({ sessionManager, sendQueue, contactService, ghlService, accessService, subscriptionService });
  workflowsService.wire({ messagingService, sessionManager });
  // eslint-disable-next-line no-new
  new InboundService({ sessionManager, contactService, ghlService, messagingService, workflowsService });
  const numbersService = new NumbersService({ sessionManager, accessService, subscriptionService });
  const agencyService = new AgencyService({ authService, accessService, subscriptionService, numbersService });
  const guards = createSessionGuards(authService);

  // ── HTTP ────────────────────────────────────────────────────
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Embedded on many white-label domains; auth is a Bearer token, not cookies → wildcard is safe.
  app.use(cors({ origin: '*', credentials: false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
  app.use(express.json({ limit: '2mb' }));

  // One line per request: 🟢 GET /api/... → 200 (12ms). Skips load-balancer health checks,
  // the long-lived live stream, and successful share-page polling (every 2s).
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const code = res.statusCode;
      // Full path (sub-routers trim req.path), no query string, share tokens masked.
      const path = (req.originalUrl || req.url).split('?')[0].replace(/^\/public\/connect\/[^/]+/, '/public/connect/:token');
      if (path === '/health' && code === 200) return;
      if (path.startsWith('/api/live')) return;
      if (req.method === 'GET' && path.startsWith('/public/connect/') && code < 400) return;
      const emoji = code >= 500 ? '🔴' : code >= 400 ? '🟡' : code >= 300 ? '🔵' : '🟢';
      logger.info(`${emoji} ${req.method} ${path} → ${code} (${Date.now() - t0}ms)`);
    });
    next();
  });

  const apiLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
  const webhookLimiter = rateLimit({ windowMs: 60_000, max: 1200, standardHeaders: true, legacyHeaders: false });

  app.get('/health', (req, res) => res.json({ status: 'ok', instance: sessionManager.instanceId, sessions: sessionManager.runtimes.size }));

  app.use('/auth', createAuthRouter(authService, accessService));
  app.use('/api/live', createLiveRouter({ guards, sessionManager, authService }));
  app.use('/api/agency', apiLimiter, createAgencyRouter({ guards, agencyService, accessService }));
  app.use(
    '/api/locations/:locationId',
    apiLimiter,
    createLocationRouter({ guards, numbersService, accessService, subscriptionService, workflowsService, messagingService }),
  );
  app.use('/webhooks', webhookLimiter, createWebhooksRouter({ messagingService, subscriptionService, numbersService, authService, workflowsService }));
  app.use('/workflows', webhookLimiter, createWorkflowsRouter(workflowsService));
  app.use('/media', createMediaRouter());

  // Feature modules (consent, rules, groups, analytics) mount routes + hooks + workflow actions.
  loadFeatures({
    app,
    express,
    guards,
    hooks,
    apiLimiter,
    webhookLimiter,
    workflowAction: (name, fn) => app.post(`/workflows/actions/${name}`, webhookLimiter, ghlSignatureGuard, workflowActionHandler(name, fn)),
    services: {
      crypto,
      authService,
      ghlService,
      subscriptionService,
      accessService,
      sessionManager,
      sendQueue,
      contactService,
      messagingService,
      workflowsService,
      numbersService,
      agencyService,
    },
  });

  // Ops: GET /admin/stats with X-Admin-Key.
  app.get('/admin/stats', async (req, res) => {
    if (!process.env.ADMIN_API_KEY || req.get('X-Admin-Key') !== process.env.ADMIN_API_KEY) return res.status(404).end();
    const WaSession = require('./schemas/wa-session.schema');
    const byStatus = await WaSession.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    return res.json({ instance: sessionManager.instanceId, running: sessionManager.runtimes.size, byStatus });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.statusCode || 500;
    if (status >= 500) logger.error('❌ Unhandled request error', { method: req.method, path: req.originalUrl, error: formatError(err), stack: err.stack });
    res.status(status).json({ success: false, error: status >= 500 ? 'Something went wrong — please try again.' : err.message, code: err.code });
  });

  cleanupExpiredMedia();
  setInterval(cleanupExpiredMedia, 60 * 60 * 1000);

  const port = Number(process.env.PORT) || 3025;
  const server = app.listen(port, () => {
    logger.info('='.repeat(50));
    logger.info('🚀 Greenline WhatsApp API started');
    logger.info('='.repeat(50));
    logger.info(`📡 Port: ${port}`);
    logger.info(`🆔 Instance: ${sessionManager.instanceId}`);
    logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info('='.repeat(50));
  });

  sessionManager.restoreAll().catch((err) => logger.error('❌ Session restore failed', { error: formatError(err) }));

  const shutdown = async (signal) => {
    logger.info(`🛑 ${signal} received — closing WhatsApp sockets (links are kept)`);
    server.close();
    try {
      await sessionManager.shutdown();
    } catch (err) {
      console.error(`Shutdown error | ${formatError(err)}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error('❌ Unhandled promise rejection', { error: formatError(err), stack: err?.stack }));
}

bootstrap().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
