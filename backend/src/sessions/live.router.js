const { Router } = require('express');

/**
 * GET /api/live?token=… — Server-Sent Events stream of number status changes (QR codes,
 * pairing codes, connected/disconnected). EventSource can't send headers, so the session JWT
 * rides in the query string. Sub-account sessions get their own location's events; agency
 * sessions get every sub-account in the agency (optionally narrowed with ?locationId=).
 */
function createLiveRouter({ guards, sessionManager, authService }) {
  const router = Router();

  router.get('/', guards.requireSession, async (req, res) => {
    const { auth } = req;
    let onlyLocation = auth.scope === 'location' ? auth.locationId : req.query.locationId || null;
    if (auth.scope === 'agency' && onlyLocation && !(await authService.locationBelongsToCompany(auth.companyId, onlyLocation))) {
      return res.status(403).json({ success: false, error: 'Sub-account is not in your agency' });
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const inScope = (evt) => (onlyLocation ? evt.locationId === onlyLocation : evt.companyId === auth.companyId);

    const onStatus = (evt) => {
      if (inScope(evt)) send('status', evt);
    };
    sessionManager.on('status', onStatus);
    send('ready', { scope: auth.scope, locationId: onlyLocation });

    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      sessionManager.off('status', onStatus);
    });
    return undefined;
  });

  return router;
}

module.exports = { createLiveRouter };
