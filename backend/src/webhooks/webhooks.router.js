const { Router } = require('express');
const logger = require('../utils/logger');
const { ghlSignatureGuard } = require('./ghl-signature');
const Installation = require('../schemas/installation.schema');
const OAuthToken = require('../schemas/oauth-token.schema');
const ArchivedToken = require('../schemas/archived-token.schema');
const CompanyLocation = require('../schemas/company-location.schema');
const MessageLog = require('../schemas/message-log.schema');
const { TRIGGERS } = require('../workflows/trigger-keys');
const { formatError } = require('../utils/format-error');

const FRIENDLY = {
  NO_NUMBER: 'No WhatsApp number is connected. Link one in the WhatsApp app.',
  NUMBER_OFFLINE: 'The WhatsApp number is offline — reconnect it in the WhatsApp app.',
  NOT_ON_WHATSAPP: 'This phone number is not on WhatsApp.',
  NO_PHONE: 'This contact has no phone number.',
  DAILY_LIMIT: 'Daily WhatsApp sending limit reached for this number.',
  SUBSCRIPTION_REQUIRED: 'No active WhatsApp subscription for this sub-account.',
  ACCESS_DISABLED: 'WhatsApp is disabled for this sub-account by your agency.',
};

/**
 * GHL → us:
 *   POST /webhooks/ghl-outbound   conversation-provider delivery URL (agent replied in Conversations)
 *   POST /webhooks/ghl            app lifecycle + marketplace billing events
 */
function createWebhooksRouter({ messagingService, subscriptionService, numbersService, authService, workflowsService }) {
  const router = Router();

  // ── Outbound: CRM → WhatsApp ────────────────────────────────
  router.post('/ghl-outbound', ghlSignatureGuard, async (req, res) => {
    const { locationId, contactId, messageId, message, attachments, phone, userId } = req.body || {};
    // Ack immediately — sends are paced (seconds apart) and GHL must not time out / retry.
    res.json({ ok: true });
    if (!locationId || !messageId) return;
    logger.info('📤 Outbound message from CRM', { locationId, contactId, messageId, attachments: Array.isArray(attachments) ? attachments.length : 0, userId });

    try {
      if (await MessageLog.exists({ locationId, ghlMessageId: messageId })) return; // GHL retry
      await messagingService.send({
        locationId,
        contactId,
        phone,
        text: message,
        attachments: Array.isArray(attachments) ? attachments : [],
        source: 'ghl',
        ghlMessageId: messageId,
        senderUserId: userId, // the GHL user who hit send (routing: their assigned number)
      });
      // Delivery/read status follows from WhatsApp receipts (MessagingService.applyReceipts).
    } catch (error) {
      const friendly = FRIENDLY[error.code] || error.message || 'WhatsApp send failed';
      logger.warn('❌ Outbound WhatsApp message failed', { locationId, contactId, messageId, code: error.code, error: formatError(error) });
      await messagingService.ghl.updateMessageStatus(locationId, messageId, 'failed', { code: (error.code || 'delivery_failed').toLowerCase(), type: 'saas', message: friendly });
      workflowsService
        .fireTrigger(TRIGGERS.MESSAGE_FAILED, locationId, {
          locationId,
          contactId,
          messageId,
          messageText: message || '',
          errorMessage: friendly,
          errorCode: error.code || '',
          timestamp: new Date().toISOString(),
        })
        .catch(() => {});
    }
  });

  // ── Lifecycle / billing ─────────────────────────────────────
  router.post('/ghl', ghlSignatureGuard, async (req, res) => {
    const p = req.body || {};
    logger.info(`📥 ${p.type || 'UNKNOWN'} webhook`, { type: p.type, appId: p.appId, companyId: p.companyId, locationId: p.locationId || '(company-level)', planId: p.planId || p.newPlanId });
    try {
      switch (p.type) {
        case 'INSTALL':
          await onInstall(p);
          break;
        case 'UPDATE':
        case 'APP_UPDATE':
          await recordInstallMeta(p); // metadata only — never touches entitlement
          break;
        case 'UNINSTALL':
          await onUninstall(p);
          break;
        case 'PLAN_CHANGE':
          await onPlanChange(p);
          break;
        case 'APP_PAYMENT_STATUS':
          await onPaymentStatus(p);
          break;
        default:
          break;
      }
    } catch (error) {
      logger.error(`❌ ${p.type} webhook handling failed`, { locationId: p.locationId, companyId: p.companyId, error: formatError(error) });
    }
    res.json({ ok: true });
  });

  async function recordInstallMeta(p) {
    if (!p.locationId) return;
    const versionId = p.versionId || p.appVersionId;
    const whitelabelDomain = p.whitelabelDetails?.domain || p.whitelabel?.domain;
    await Installation.findOneAndUpdate(
      { locationId: p.locationId },
      {
        $set: {
          ...(p.companyId ? { companyId: p.companyId } : {}),
          ...(p.appId ? { appId: p.appId } : {}),
          ...(versionId ? { versionId } : {}),
          ...(whitelabelDomain ? { whitelabelDomain } : {}),
        },
      },
    );
  }

  async function onInstall(p) {
    const { locationId, companyId } = p;
    if (!locationId && companyId) {
      // Agency-level install: pull the sub-account directory (company token arrives via OAuth).
      authService.syncCompanyLocations(companyId).catch((err) => console.warn(`[Lifecycle] directory sync: ${err.message}`));
      return;
    }
    if (!locationId) return;
    if (companyId) await CompanyLocation.updateOne({ companyId }, { $addToSet: { locationIds: locationId } }, { upsert: true });
    await Installation.findOneAndUpdate(
      { locationId },
      {
        $set: { companyId: companyId || '', status: 'active', ...(p.appId ? { appId: p.appId } : {}) },
        $unset: { uninstalledAt: '' },
        $setOnInsert: { installedAt: new Date(), conversationProviderId: process.env.GHL_CONVERSATION_PROVIDER_ID || '' },
      },
      { upsert: true },
    );
    await recordInstallMeta(p);
    await subscriptionService.onInstall({ locationId, companyId, appId: p.appId, planId: p.planId, raw: p });
    logger.info('✅ Installation recorded', { locationId, companyId, appId: p.appId });
    await numbersService.reconcile(locationId); // resume numbers paused while uninstalled/unpaid
  }

  async function onUninstall(p) {
    const { locationId, companyId } = p;
    if (!locationId && companyId) {
      await OAuthToken.updateMany({ companyId, tokenType: 'company' }, { $set: { isActive: false } });
      return;
    }
    if (!locationId) return;
    const token = await OAuthToken.findOne({ locationId, tokenType: 'location' });
    if (token) {
      await ArchivedToken.create({
        companyId: token.companyId,
        locationId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        originalCreatedAt: token.createdAt,
        originalExpiresAt: token.expiresAt,
        deletionReason: 'app_uninstall',
        uninstallWebhookData: p,
      }).catch(() => {});
      await OAuthToken.deleteOne({ _id: token._id });
    }
    await Installation.updateOne({ locationId }, { $set: { status: 'uninstalled', uninstalledAt: new Date() } });
    const { loggedOut } = await numbersService.logoutLocation(locationId); // unlink devices from the customer's phone
    logger.info('✅ Uninstall cleanup done', { locationId, numbersLoggedOut: loggedOut });
    await subscriptionService.setStatus(locationId, 'canceled');
  }

  async function onPlanChange(p) {
    const locationId = p.locationId;
    if (!locationId) return;
    await subscriptionService.onPlanChange({ locationId, companyId: p.companyId, appId: p.appId, planId: p.planId || p.newPlanId, raw: p });
    await numbersService.reconcile(locationId); // pause overflow on downgrade, resume on upgrade
  }

  async function onPaymentStatus(p) {
    const status = String(p.paymentStatus || p.status || '').toUpperCase();
    if (!p.locationId) return;
    if (status === 'FAILED') await subscriptionService.setStatus(p.locationId, 'past_due');
    else if (['COMPLETE', 'COMPLETED', 'SUCCESS'].includes(status)) {
      await subscriptionService.setStatus(p.locationId, 'active');
      await numbersService.reconcile(p.locationId);
    }
  }

  return router;
}

module.exports = { createWebhooksRouter };
