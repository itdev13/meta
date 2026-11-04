const CompanyLocation = require('../schemas/company-location.schema');
const Installation = require('../schemas/installation.schema');
const LocationAccess = require('../schemas/location-access.schema');
const WaSession = require('../schemas/wa-session.schema');
const MessageLog = require('../schemas/message-log.schema');
const AccessService = require('../access/access.service');

const ATTENTION = ['disconnected', 'logged_out', 'banned', 'replaced'];

/**
 * Agency console: one view of every sub-account — install state, access policy, plan,
 * linked numbers and health — plus the controls to allow/block, cap and manage them.
 */
class AgencyService {
  constructor({ authService, accessService, subscriptionService, numbersService }) {
    this.auth = authService;
    this.access = accessService;
    this.subscription = subscriptionService;
    this.numbers = numbersService;
  }

  async _directory(companyId, { refresh = false } = {}) {
    let cl = await CompanyLocation.findOne({ companyId }).lean();
    const stale = !cl?.syncedAt || Date.now() - new Date(cl.syncedAt).getTime() > 6 * 60 * 60 * 1000;
    if ((refresh || !cl?.locations?.length || stale) && (await this.auth.hasCompanyToken(companyId))) {
      try {
        await this.auth.syncCompanyLocations(companyId);
        cl = await CompanyLocation.findOne({ companyId }).lean();
      } catch (err) {
        console.warn(`[Agency] directory sync failed for ${companyId}: ${err.message}`);
      }
    }
    const known = new Map((cl?.locations || []).map((l) => [l.id, l]));
    // Sub-accounts installed individually (no agency token) still show, with whatever we know.
    const installs = await Installation.find({ companyId }).select('locationId locationName status').lean();
    for (const i of installs) if (!known.has(i.locationId)) known.set(i.locationId, { id: i.locationId, name: i.locationName || '' });
    for (const id of cl?.locationIds || []) if (!known.has(id)) known.set(id, { id, name: '' });
    return { list: [...known.values()], installs, syncedAt: cl?.syncedAt || null };
  }

  async overview(companyId, { refresh = false } = {}) {
    const [{ list, installs, syncedAt }, settings] = await Promise.all([this._directory(companyId, { refresh }), this.access.getSettings(companyId)]);
    const ids = list.map((l) => l.id);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [accessRows, subMap, sessions, msgRows] = await Promise.all([
      LocationAccess.find({ locationId: { $in: ids } }).lean(),
      this.subscription.statusMap(ids),
      WaSession.find({ locationId: { $in: ids } }).select('locationId label phoneNumber waName status pausedReason isDefault lastSeenAt lastMessageAt').lean(),
      MessageLog.aggregate([
        { $match: { companyId, createdAt: { $gte: since } } },
        { $group: { _id: { l: '$locationId', d: '$direction' }, n: { $sum: 1 } } },
      ]),
    ]);

    const accessBy = new Map(accessRows.map((a) => [a.locationId, a]));
    const installBy = new Map(installs.map((i) => [i.locationId, i]));
    const sessionsBy = new Map();
    for (const s of sessions) {
      if (!sessionsBy.has(s.locationId)) sessionsBy.set(s.locationId, []);
      sessionsBy.get(s.locationId).push(s);
    }
    const msgsBy = new Map();
    for (const r of msgRows) {
      const m = msgsBy.get(r._id.l) || { inbound: 0, outbound: 0 };
      m[r._id.d] = r.n;
      msgsBy.set(r._id.l, m);
    }

    const subAccounts = list.map((loc) => {
      const access = accessBy.get(loc.id) || null;
      const nums = sessionsBy.get(loc.id) || [];
      const sub = subMap[loc.id] || null;
      const install = installBy.get(loc.id);
      return {
        id: loc.id,
        name: loc.name || install?.locationName || 'Unnamed sub-account',
        email: loc.email || '',
        city: [loc.city, loc.country].filter(Boolean).join(', '),
        logoUrl: loc.logoUrl || '',
        installed: install ? install.status === 'active' : !!sub,
        allowed: AccessService.isAllowed(settings, access),
        override: access?.enabled ?? null,
        numberLimitOverride: access?.numberLimit ?? null,
        note: access?.note || '',
        request: access?.request?.status === 'pending' ? access.request : null,
        subscription: sub,
        numbers: nums.map((n) => ({
          id: String(n._id),
          label: n.label,
          phoneNumber: n.phoneNumber || null,
          waName: n.waName || '',
          status: n.status,
          pausedReason: n.pausedReason,
          isDefault: !!n.isDefault,
          lastSeenAt: n.lastSeenAt,
        })),
        connected: nums.filter((n) => n.status === 'connected').length,
        attention: nums.filter((n) => ATTENTION.includes(n.status)).length,
        messages24h: msgsBy.get(loc.id) || { inbound: 0, outbound: 0 },
      };
    });

    subAccounts.sort((a, b) => (b.request ? 1 : 0) - (a.request ? 1 : 0) || b.connected - a.connected || a.name.localeCompare(b.name));

    const summary = {
      subAccounts: subAccounts.length,
      allowed: subAccounts.filter((s) => s.allowed).length,
      connectedNumbers: subAccounts.reduce((n, s) => n + s.connected, 0),
      attention: subAccounts.reduce((n, s) => n + s.attention, 0),
      pendingRequests: subAccounts.filter((s) => s.request).length,
      messages24h: subAccounts.reduce((n, s) => n + s.messages24h.inbound + s.messages24h.outbound, 0),
    };

    return { summary, settings, subAccounts, syncedAt, agencyInstalled: await this.auth.hasCompanyToken(companyId) };
  }

  async setAccess(companyId, locationId, patch, updatedBy) {
    const row = await this.access.setLocationAccess(companyId, locationId, patch, updatedBy);
    await this.numbers.reconcile(locationId);
    return row;
  }

  async bulkAccess(companyId, locationIds, enabled, updatedBy) {
    const results = [];
    for (const locationId of locationIds.slice(0, 500)) {
      if (!(await this.auth.locationBelongsToCompany(companyId, locationId))) continue;
      await this.setAccess(companyId, locationId, { enabled }, updatedBy);
      results.push(locationId);
    }
    return { updated: results.length };
  }

  async declineRequest(companyId, locationId, updatedBy) {
    await this.access.declineRequest(companyId, locationId, updatedBy);
    return { declined: true };
  }

  /** Settings change may flip access for many sub-accounts (mode switch / cap) → reconcile all with numbers. */
  async updateSettings(companyId, patch, updatedBy) {
    const before = await this.access.getSettings(companyId);
    const settings = await this.access.updateSettings(companyId, patch, updatedBy);
    const policyChanged = before.accessMode !== settings.accessMode || before.defaultNumberLimit !== settings.defaultNumberLimit;
    if (policyChanged) {
      const locs = await WaSession.distinct('locationId', { companyId });
      for (const l of locs) await this.numbers.reconcile(l).catch((err) => console.warn(`[Agency] reconcile ${l}: ${err.message}`));
    }
    return settings;
  }
}

module.exports = AgencyService;
