# WhatsApp Connector (QR / linked device)

A GHL marketplace app that links ordinary WhatsApp numbers to the CRM by scanning a QR code, the same way WhatsApp Web does. It does not use Meta's Cloud API. Messages sync both ways with Conversations, workflows can send WhatsApp messages, and agencies control which sub-accounts may use it.

```
whatsapp/
  backend/   Express + Mongoose + Baileys (@whiskeysockets/baileys), port 3025
  frontend/  React + Vite: one build that shows the agency console or the sub-account page
```

## How it fits together

| Piece | Where |
|---|---|
| OAuth, agency token → lazily minted sub-account tokens, SSO → JWT session | `backend/src/auth/` |
| Agency policy: access mode, per-sub-account on/off, number caps, access requests | `backend/src/access/`, `backend/src/agency/` |
| WhatsApp sockets: one per linked number, auth state encrypted in Mongo, single-owner lease | `backend/src/whatsapp/session-manager.js`, `mongo-auth-state.js` |
| Anti-ban pacing: serial per number, jittered gap, typing indicator, daily cap | `backend/src/whatsapp/send-queue.js` |
| WhatsApp → CRM: contacts matched by phone or LID, media upload, replies typed on the phone mirrored into the CRM | `backend/src/whatsapp/inbound.service.js` |
| CRM/workflow → WhatsApp: routes through the number the contact last used | `backend/src/whatsapp/messaging.service.js` |
| Lifecycle and billing webhooks: install, uninstall, plan change, payment | `backend/src/webhooks/webhooks.router.js` |
| Live QR, pairing code and status stream (SSE) | `backend/src/sessions/live.router.js` |
| Workflows: 6 triggers and 4 actions | `backend/src/workflows/` |

### Agency vs sub-account

- **Agency console** (opened from the agency-level custom page):
  - Lists every sub-account, with a KPI row.
  - Turns WhatsApp on or off per sub-account, or in bulk.
  - Approves or declines access requests.
  - Can link a number on a client's behalf (the agency scans the QR).
  - The drawer for each sub-account handles number caps, linked numbers and activity.
  - The policy tab holds access mode, self-connect, access requests, default cap and sending safety.
- **Sub-account page** (opened from the location-level custom page):
  - A first-run hero.
  - Number cards showing health, plus link / relink / pause / unlink / settings.
  - Activity feed, automations list and plans.
  - If the agency hasn't enabled the sub-account, the user sees a locked screen with a "Request access" button.

The effective number limit for a sub-account is the plan's `numberLimit`, further capped by the agency. If the agency set a cap for that specific sub-account, that cap is used. Otherwise the agency's default cap applies. So it is `min(plan, perSubAccountCap ?? agencyDefault)`, and a per-sub-account cap can be higher than the default.

## GHL marketplace configuration

| Setting | Value |
|---|---|
| Redirect URL | `${BACKEND_URL}/auth/callback` |
| Install / referral link | `${BACKEND_URL}/auth/authorize` |
| Webhook URL (INSTALL, UNINSTALL, UPDATE, PLAN_CHANGE, APP_PAYMENT_STATUS) | `${BACKEND_URL}/webhooks/ghl` |
| Conversation provider → Delivery URL | `${BACKEND_URL}/webhooks/ghl-outbound` (type **Custom**, or **SMS** if `GHL_MESSAGE_TYPE=SMS`) |
| Custom page (Agency) | `${FRONTEND_URL}` |
| Custom page (Sub-account) | `${FRONTEND_URL}` |
| Workflow triggers subscription URL | `${BACKEND_URL}/workflows/triggers/subscriptions` |
| Workflow actions | `${BACKEND_URL}/workflows/actions/{send-message, send-media, send-to-number, check-number}` |
| Distribution | Agency **and** sub-account install, so the agency token can mint sub-account tokens |

The trigger and action keys are in `backend/src/workflows/trigger-keys.js` and must match the dashboard exactly.

Scopes are listed in `backend/src/auth/auth.router.js` (`SCOPES`).

Plans: put the real GHL plan IDs into `PLANS_JSON` with a `numberLimit` for each.

## Run locally

```bash
cd backend  && cp .env.example .env   # fill ENCRYPTION_KEY (openssl rand -hex 32), JWT_SECRET, GHL_*; set ALLOW_DEV_LOGIN=true
npm install && npm run start:dev
cd ../frontend && cp .env.example .env && npm install && npm run dev
# Agency console:   http://localhost:5290/?dev=agency&company=<companyId>
# Sub-account page: http://localhost:5290/?dev=location&company=<companyId>&location=<locationId>
```

Dev login skips GHL SSO but still needs real install data to sync messages. The QR linking flow works with any phone.

## Deploying

- **Long-running process.** Sockets are stateful, so this cannot run on Lambda or serverless. Use pm2 or a VM.
- **One process per `INSTANCE_ID`.** Sessions are leased to one instance at a time (90 s lease, renewed every 30 s), so a second process never drives the same number. With several instances, give each its own `INSTANCE_ID`. A session moves to another instance only after its lease expires.
- **Rough capacity estimate (not measured).** Each linked number should use roughly 20–50 MB of RAM. Load-test before you size servers.
- **Graceful restarts.** SIGTERM closes sockets but keeps the links. They reconnect on boot without anyone re-scanning a QR.

## Known limits and risks

- **Unofficial client.** Linking through WhatsApp Web is outside WhatsApp's business terms. Numbers that send bulk or unsolicited messages get banned. Sending is paced and capped by default; keep it that way.
- **Marketplace review.** Confirm with GHL that a QR-based WhatsApp app is acceptable before listing it publicly.
- **Groups sync only when enabled.** Turn on "Sync WhatsApp groups" per number; each group becomes one CRM contact. Broadcast lists and channels are always ignored.
- **Session expiry.** A linked device stops working if the phone is offline for about 14 days. The number then shows "Logged out", the `whatsapp_number_disconnected` trigger fires, and the user re-links with one click.
- **Baileys is pinned to `6.7.24`** (6.7.18 had a message-spoofing advisory, GHSA-qvv5-jq5g-4cgg). Upgrade deliberately: WhatsApp protocol changes ship as Baileys releases.
