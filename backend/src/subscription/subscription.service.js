const Subscription = require('../schemas/subscription.schema');
const TrialLedger = require('../schemas/trial-ledger.schema');
const Installation = require('../schemas/installation.schema');

const DAY = 24 * 60 * 60 * 1000;

/**
 * Per sub-account subscription entitlement. GHL Marketplace collects the monthly fee (and the
 * agency can rebill it); we mirror the status, map planId → numberLimit, and run a one-time
 * trial recorded in TrialLedger (never deleted, so reinstalling can't reset it).
 *
 * PLANS_JSON: {"<ghlPlanId>":{"name":"Starter","priceUsd":29,"numberLimit":1}, ...}
 */
class SubscriptionService {
  constructor() {
    this.required = process.env.SUBSCRIPTION_REQUIRED !== 'false';
    this.trialDays = process.env.TRIAL_DAYS === undefined ? 3 : Number(process.env.TRIAL_DAYS);
    this.graceDays = Number(process.env.TRIAL_CONVERT_GRACE_DAYS) || 4;
    this.plans = {};
    try {
      if (process.env.PLANS_JSON) this.plans = JSON.parse(process.env.PLANS_JSON);
    } catch (err) {
      console.warn(`[Subscription] PLANS_JSON parse failed: ${err.message}`);
    }
  }

  planForId(planId) {
    if (planId && this.plans[planId]) {
      const p = this.plans[planId];
      return { planId, name: p.name, priceUsd: Number(p.priceUsd) || 0, numberLimit: Number(p.numberLimit) || 1 };
    }
    return {
      planId: planId || null,
      name: process.env.PLAN_NAME || 'Starter',
      priceUsd: Number(process.env.PLAN_PRICE_USD) || 0,
      numberLimit: Number(process.env.PLAN_NUMBER_LIMIT) || 1,
    };
  }

  /**
   * INSTALL: create the subscription if this location has none (or was canceled), granting the
   * trial once. A duplicate INSTALL / an UPDATE for an existing live subscription changes nothing
   * except the plan metadata — it must never downgrade a trialing/paying location.
   */
  async onInstall({ locationId, companyId, appId, planId, raw }) {
    const existing = await Subscription.findOne({ locationId });
    const plan = this.planForId(planId || existing?.planId);
    const meta = { companyId, appId, planId: plan.planId, planName: plan.name, priceUsd: plan.priceUsd, numberLimit: plan.numberLimit, rawWebhookData: raw };

    if (existing && ['active', 'trialing', 'past_due'].includes(existing.status)) {
      await Subscription.updateOne({ locationId }, { $set: meta });
      return Subscription.findOne({ locationId });
    }

    const now = new Date();
    const update = { ...meta };
    const usedTrial = await TrialLedger.exists({ locationId });
    if (this.trialDays > 0 && !usedTrial) {
      const trialEndsAt = new Date(now.getTime() + this.trialDays * DAY);
      update.status = 'trialing';
      update.trialEndsAt = trialEndsAt;
      await TrialLedger.updateOne(
        { locationId },
        { $setOnInsert: { locationId, companyId, firstTrialStartedAt: now, trialEndsAt, planId: plan.planId } },
        { upsert: true },
      );
    } else if (planId) {
      // Reinstall with a plan selected on the marketplace → paid straight away.
      update.status = 'active';
      update.currentPeriodStart = now;
      update.currentPeriodEnd = new Date(now.getTime() + 30 * DAY);
    } else {
      update.status = 'inactive';
    }
    update.canceledAt = null;
    await Subscription.updateOne({ locationId }, { $set: update }, { upsert: true });
    console.log(`[Subscription] ${locationId} → ${update.status} (${plan.name})`);
    return Subscription.findOne({ locationId });
  }

  async onPlanChange({ locationId, companyId, appId, planId, raw }) {
    const plan = this.planForId(planId);
    const now = new Date();
    await Subscription.updateOne(
      { locationId },
      {
        $set: {
          companyId,
          appId,
          planId: plan.planId,
          planName: plan.name,
          priceUsd: plan.priceUsd,
          numberLimit: plan.numberLimit,
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + 30 * DAY),
          rawWebhookData: raw,
        },
      },
      { upsert: true },
    );
    return Subscription.findOne({ locationId });
  }

  async setStatus(locationId, status) {
    const extra = status === 'canceled' ? { canceledAt: new Date() } : {};
    await Subscription.updateOne({ locationId }, { $set: { status, ...extra } });
  }

  /** GHL sends no webhook when a trial converts → flip trialing → active after trial + grace. */
  async maybeConvertExpiredTrial(sub) {
    if (!sub || sub.status !== 'trialing' || !sub.trialEndsAt) return sub;
    if (Date.now() < new Date(sub.trialEndsAt).getTime() + this.graceDays * DAY) return sub;
    const now = new Date();
    await Subscription.updateOne(
      { locationId: sub.locationId },
      { $set: { status: 'active', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY) } },
    );
    return Subscription.findOne({ locationId: sub.locationId });
  }

  async getStatus(locationId) {
    let sub = await Subscription.findOne({ locationId });
    if (sub) sub = await this.maybeConvertExpiredTrial(sub);
    const entitled = !this.required || (sub ? sub.isEntitled() : false);
    const isTrial = sub?.status === 'trialing';
    const trialDaysLeft = isTrial && sub.trialEndsAt ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / DAY)) : 0;
    const fallback = this.planForId(null);
    return {
      entitled,
      required: this.required,
      status: sub?.status || (this.required ? 'inactive' : 'active'),
      isTrial,
      trialDaysLeft,
      trialEndsAt: sub?.trialEndsAt || null,
      plan: sub
        ? { planId: sub.planId, name: sub.planName, priceUsd: sub.priceUsd, numberLimit: sub.numberLimit }
        : this.required
          ? null
          : { planId: null, name: fallback.name, priceUsd: fallback.priceUsd, numberLimit: fallback.numberLimit },
      currentPeriodEnd: sub?.currentPeriodEnd || null,
    };
  }

  /** Batch status for the agency dashboard (no trial auto-convert writes, read-only). */
  async statusMap(locationIds) {
    const subs = await Subscription.find({ locationId: { $in: locationIds } }).lean();
    const map = {};
    for (const s of subs) {
      map[s.locationId] = {
        required: this.required,
        status: s.status,
        entitled: !this.required || s.status === 'active' || s.status === 'trialing',
        planName: s.planName,
        numberLimit: s.numberLimit,
        trialEndsAt: s.trialEndsAt,
      };
    }
    return map;
  }

  async planNumberLimit(locationId) {
    if (!this.required) {
      const sub = await Subscription.findOne({ locationId }).lean();
      return sub?.numberLimit || this.planForId(null).numberLimit;
    }
    const status = await this.getStatus(locationId);
    if (!status.entitled) return 0;
    return status.plan?.numberLimit ?? 0;
  }

  async ensureEntitled(locationId) {
    if (!this.required) return;
    const { entitled } = await this.getStatus(locationId);
    if (!entitled) {
      const err = new Error('An active subscription is required for this sub-account.');
      err.statusCode = 402;
      err.code = 'SUBSCRIPTION_REQUIRED';
      throw err;
    }
  }

  async buildUpgradeUrl(locationId, mode = 'enrol') {
    if (process.env.MARKETPLACE_UPGRADE_URL) return process.env.MARKETPLACE_UPGRADE_URL;
    const inst = await Installation.findOne({ locationId }).lean();
    const appId = inst?.appId || process.env.GHL_APP_ID;
    if (!appId || !locationId) return '';
    const versionId = inst?.versionId || process.env.GHL_APP_VERSION_ID || '';
    const host = String(inst?.whitelabelDomain || process.env.GHL_DEFAULT_APP_DOMAIN || 'app.gohighlevel.com')
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '');
    const base = `https://${host}/v2/location/${locationId}/integration/${appId}`;
    if (mode === 'upgrade') return `${base}/upgrade-plans?app_from=installedApps`;
    return `${versionId ? `${base}/versions/${versionId}` : base}?view=subAccount`;
  }

  async listPlans(locationId) {
    const sub = await Subscription.findOne({ locationId }).lean();
    const hasPlan = !!sub && ['active', 'past_due', 'trialing'].includes(sub.status);
    const url = await this.buildUpgradeUrl(locationId, hasPlan ? 'upgrade' : 'enrol');
    const entries = Object.keys(this.plans).map((planId) => ({ ...this.planForId(planId), isCurrent: sub?.planId === planId, url }));
    if (!entries.length) entries.push({ ...this.planForId(null), isCurrent: true, url });
    return entries.sort((a, b) => a.priceUsd - b.priceUsd);
  }
}

module.exports = SubscriptionService;
