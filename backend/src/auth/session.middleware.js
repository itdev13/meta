/**
 * Embedded-UI auth guards.
 *
 *   requireSession      — valid JWT (Authorization: Bearer, or ?token= for EventSource)
 *   requireAgency       — agency-scope session
 *   requireAgencyAdmin  — agency-scope AND GHL role admin (mutations from the agency console)
 *   resolveLocation(p)  — the location in req.params[p] must be the session's own location
 *                         (sub-account scope) or one of the agency's sub-accounts (agency
 *                         scope). Sets req.locationId; never trust a locationId otherwise.
 */
function createSessionGuards(authService) {
  function requireSession(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ success: false, error: 'Missing session', code: 'NO_SESSION' });
    try {
      req.auth = authService.verifySession(token);
      return next();
    } catch {
      return res.status(401).json({ success: false, error: 'Session expired — reload the page', code: 'SESSION_EXPIRED' });
    }
  }

  function requireAgency(req, res, next) {
    if (req.auth?.scope !== 'agency') {
      return res.status(403).json({ success: false, error: 'Agency access required', code: 'AGENCY_ONLY' });
    }
    return next();
  }

  function requireAgencyAdmin(req, res, next) {
    if (req.auth?.scope !== 'agency') {
      return res.status(403).json({ success: false, error: 'Agency access required', code: 'AGENCY_ONLY' });
    }
    if (req.auth.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only agency admins can change this', code: 'ADMIN_ONLY' });
    }
    return next();
  }

  function resolveLocation(param = 'locationId') {
    return async (req, res, next) => {
      const locationId = req.params[param];
      if (!locationId) return res.status(400).json({ success: false, error: 'locationId required' });
      try {
        if (req.auth.scope === 'location') {
          if (locationId !== req.auth.locationId) {
            return res.status(403).json({ success: false, error: 'Not your sub-account', code: 'LOCATION_MISMATCH' });
          }
        } else if (req.auth.scope === 'agency') {
          const ok = await authService.locationBelongsToCompany(req.auth.companyId, locationId);
          if (!ok) return res.status(403).json({ success: false, error: 'Sub-account is not in your agency', code: 'LOCATION_NOT_IN_AGENCY' });
        } else {
          return res.status(403).json({ success: false, error: 'Invalid session scope' });
        }
        req.locationId = locationId;
        return next();
      } catch (err) {
        return next(err);
      }
    };
  }

  return { requireSession, requireAgency, requireAgencyAdmin, resolveLocation };
}

module.exports = { createSessionGuards };
