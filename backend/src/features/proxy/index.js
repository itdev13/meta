const mongoose = require('mongoose');
const WaSession = require('../../schemas/wa-session.schema');
const pool = require('./proxy-pool');

const NOT_RESTARTABLE = new Set(['paused', 'logged_out', 'banned', 'replaced', 'qr_expired', 'pending', 'qr', 'pairing']);

function httpError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * Feature: proxy per number (bring-your-own pool from PROXY_POOL_JSON).
 *
 *   GET  /api/locations/:locationId/proxy/countries
 *        → { enabled, countries: [{ code, name, count }] }   (never URLs)
 *   POST /api/locations/:locationId/proxy/apply/:numberId
 *        Restarts that number's socket so a changed settings.proxyCountry takes effect now
 *        (the link is kept). → { numberId, applied, reason?, proxyCountry, route, status }
 *
 * The proxy itself is chosen in SessionManager._connect on every (re)connect.
 */
function register({ app, express, guards, services }) {
  const manager = services.sessionManager;
  const router = express.Router({ mergeParams: true });
  router.use(guards.requireSession, guards.resolveLocation('locationId'));
  const wrap = (fn) => async (req, res, next) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };

  router.get(
    '/countries',
    wrap(async () => ({ enabled: pool.isEnabled(), countries: pool.listCountries() })),
  );

  router.post(
    '/apply/:numberId',
    wrap(async (req) => {
      const { locationId } = req;
      await services.accessService.ensureCanManageNumbers(req.auth, locationId);
      const { numberId } = req.params;
      if (!mongoose.isValidObjectId(numberId)) throw httpError('Number not found', 404, 'NOT_FOUND');
      const doc = await WaSession.findOne({ _id: numberId, locationId }).lean();
      if (!doc) throw httpError('Number not found', 404, 'NOT_FOUND');

      const proxyCountry = doc.settings?.proxyCountry || '';
      const picked = pool.pickProxy(doc._id, proxyCountry);
      const route = !picked ? 'direct' : picked.missing ? 'direct_no_proxies' : 'proxy';
      const base = { numberId: String(doc._id), proxyCountry, route };

      // Mid-link, paused or terminal numbers: nothing to restart — the setting applies on the next connect.
      if (!doc.registered || !doc.isActive || NOT_RESTARTABLE.has(doc.status)) {
        return { ...base, applied: false, reason: 'not_running', status: doc.status };
      }
      // Respect the single-owner lease: another server is driving this number.
      const leasedElsewhere = doc.ownerId && doc.ownerId !== manager.instanceId && doc.leaseUntil && new Date(doc.leaseUntil) > new Date();
      if (leasedElsewhere) {
        throw httpError('This number is being handled by another server — try again in a minute.', 409, 'SESSION_LEASED');
      }

      await manager.stop(doc._id, { status: 'connecting' });
      await manager.start(doc._id);
      const live = manager.snapshot(doc._id);
      return { ...base, applied: true, status: live?.status || 'connecting' };
    }),
  );

  app.use('/api/locations/:locationId/proxy', router);
}

module.exports = { register };
