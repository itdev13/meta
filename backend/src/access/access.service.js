const AgencySettings = require('../schemas/agency-settings.schema');
const LocationAccess = require('../schemas/location-access.schema');
const CompanyLocation = require('../schemas/company-location.schema');
const Installation = require('../schemas/installation.schema');

/**
 * Agency → sub-account access policy. Answers three questions for any location:
 *   1. Is WhatsApp allowed here at all?          (agency accessMode + per-location override)
 *   2. May sub-account users link numbers?        (agency allowSelfConnect)
 *   3. How many numbers may be linked?            (min of plan limit, agency caps)
 */
class AccessService {
  constructor(subscriptionService, authService) {
    this.subscription = subscriptionService;
    this.auth = authService;
  }

  async companyIdFor(locationId) {
    const inst = await Installation.findOne({ locationId }).select('companyId').lean();
    if (inst?.companyId) return inst.companyId;
    const cl = await CompanyLocation.findOne({ locationIds: locationId }).select('companyId').lean();
    return cl?.companyId || '';
  }

  async getSettings(companyId) {
    if (!companyId) return new AgencySettings({ companyId: '' }).toObject();
    const doc = await AgencySettings.findOne({ companyId }).lean();
    return doc || new AgencySettings({ companyId }).toObject();
  }

  async updateSettings(companyId, patch, updatedBy) {
    const allowed = ['accessMode', 'allowSelfConnect', 'allowAccessRequests', 'defaultNumberLimit', 'defaultMinDelayMs', 'defaultDailyLimit'];
    const $set = { updatedBy };
    for (const k of allowed) if (k in patch) $set[k] = patch[k];
    if ($set.accessMode && !['all', 'selected'].includes($set.accessMode)) {
      const err = new Error('accessMode must be "all" or "selected"');
      err.statusCode = 400;
      throw err;
    }
    for (const k of ['defaultNumberLimit', 'defaultMinDelayMs', 'defaultDailyLimit']) {
      if (k in $set && $set[k] !== null) {
        const n = Number($set[k]);
        if (!Number.isFinite(n) || n < 0) {
          const err = new Error(`${k} must be a positive number or null`);
          err.statusCode = 400;
          throw err;
        }
        $set[k] = Math.round(n);
      }
    }
    await AgencySettings.updateOne({ companyId }, { $set, $setOnInsert: { companyId } }, { upsert: true });
    return this.getSettings(companyId);
  }

  static isAllowed(settings, access) {
    if (access && access.enabled === true) return true;
    if (access && access.enabled === false) return false;
    return settings.accessMode === 'all';
  }

  async evaluate(locationId, companyIdHint) {
    const companyId = companyIdHint || (await this.companyIdFor(locationId));
    const [settings, access, sub, planLimit] = await Promise.all([
      this.getSettings(companyId),
      LocationAccess.findOne({ locationId }).lean(),
      this.subscription.getStatus(locationId),
      this.subscription.planNumberLimit(locationId),
    ]);
    const allowed = AccessService.isAllowed(settings, access);
    const caps = [planLimit];
    if (access?.numberLimit != null) caps.push(access.numberLimit);
    else if (settings.defaultNumberLimit != null) caps.push(settings.defaultNumberLimit);
    const numberLimit = allowed ? Math.max(0, Math.min(...caps)) : 0;

    return {
      companyId,
      allowed,
      accessMode: settings.accessMode,
      selfConnect: settings.allowSelfConnect !== false,
      canRequestAccess: !allowed && settings.allowAccessRequests !== false,
      request: access?.request?.status && access.request.status !== 'none' ? access.request : null,
      numberLimit,
      planNumberLimit: planLimit,
      agencyNumberLimit: access?.numberLimit ?? settings.defaultNumberLimit ?? null,
      subscription: sub,
      pace: {
        minDelayMs: settings.defaultMinDelayMs ?? (Number(process.env.WA_DEFAULT_MIN_DELAY_MS) || 1500),
        dailyLimit: settings.defaultDailyLimit ?? (Number(process.env.WA_DEFAULT_DAILY_LIMIT) || 1000),
      },
    };
  }

  /** Throws 403 when the agency hasn't enabled this sub-account. */
  async ensureAllowed(locationId) {
    const ev = await this.evaluate(locationId);
    if (!ev.allowed) {
      const err = new Error('Your agency has not enabled WhatsApp for this sub-account.');
      err.statusCode = 403;
      err.code = 'ACCESS_DISABLED';
      throw err;
    }
    return ev;
  }

  /**
   * Can THIS session link/unlink numbers on locationId? Agency admins always can; sub-account
   * users only when the agency allows self-connect. Throws 403 otherwise.
   */
  async ensureCanManageNumbers(auth, locationId) {
    const ev = await this.ensureAllowed(locationId);
    if (auth.scope === 'agency') return ev;
    if (!ev.selfConnect) {
      const err = new Error('Your agency manages WhatsApp numbers for this sub-account. Ask them to link one.');
      err.statusCode = 403;
      err.code = 'AGENCY_MANAGED';
      throw err;
    }
    return ev;
  }

  async setLocationAccess(companyId, locationId, patch, updatedBy) {
    const $set = { companyId, updatedBy };
    if ('enabled' in patch) $set.enabled = patch.enabled === null ? null : !!patch.enabled;
    if ('numberLimit' in patch) {
      $set.numberLimit = patch.numberLimit === null || patch.numberLimit === '' ? null : Math.max(0, Math.round(Number(patch.numberLimit)));
    }
    if ('note' in patch) $set.note = String(patch.note || '').slice(0, 500);
    // An explicit enable answers any pending request.
    if (patch.enabled === true) {
      $set['request.status'] = 'approved';
      $set['request.decidedAt'] = new Date();
    }
    await LocationAccess.updateOne({ locationId }, { $set }, { upsert: true });
    return LocationAccess.findOne({ locationId }).lean();
  }

  async requestAccess(auth, message) {
    const ev = await this.evaluate(auth.locationId, auth.companyId);
    if (ev.allowed) return { alreadyAllowed: true };
    if (!ev.canRequestAccess) {
      const err = new Error('Your agency is not accepting access requests.');
      err.statusCode = 403;
      throw err;
    }
    await LocationAccess.updateOne(
      { locationId: auth.locationId },
      {
        $set: {
          companyId: ev.companyId,
          'request.status': 'pending',
          'request.requestedAt': new Date(),
          'request.requestedBy': { userId: auth.userId, name: auth.name, email: auth.email },
          'request.message': String(message || '').slice(0, 500),
        },
      },
      { upsert: true },
    );
    return { requested: true };
  }

  async declineRequest(companyId, locationId, updatedBy) {
    await LocationAccess.updateOne(
      { companyId, locationId },
      { $set: { 'request.status': 'declined', 'request.decidedAt': new Date(), updatedBy } },
    );
  }

  /** What the UI needs right after login. */
  async describeContext(claims) {
    if (claims.scope === 'agency') {
      const [settings, hasCompanyToken, cl] = await Promise.all([
        this.getSettings(claims.companyId),
        this.auth.hasCompanyToken(claims.companyId),
        CompanyLocation.findOne({ companyId: claims.companyId }).select('locationIds syncedAt').lean(),
      ]);
      return {
        scope: 'agency',
        settings,
        agencyInstalled: hasCompanyToken,
        subAccountCount: cl?.locationIds?.length || 0,
        isAdmin: claims.role === 'admin',
      };
    }
    const ev = await this.evaluate(claims.locationId, claims.companyId);
    return { scope: 'location', access: ev };
  }
}

module.exports = AccessService;
