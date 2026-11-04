# Deploying the WhatsApp Connector

This guide takes you from nothing to a live install in a real sub-account. Follow the sections in order. The domains below are suggestions; swap in your own everywhere.

| Piece | Where it runs | Suggested address |
|---|---|---|
| **API** (`backend/`) | Ubuntu VM, Node 22, managed by pm2, behind nginx or a Cloudflare tunnel | `https://whatsappapi.vaultsuite.store` |
| **UI** (`frontend/`) | Vercel (static site) | `https://whatsapp.vaultsuite.store` |
| **Database** | MongoDB Atlas (M10 or larger for production) | n/a |

> **The API must run on a long-lived server, not on Lambda, Vercel functions or any other serverless host.**
>
> Each linked number is a permanently open WebSocket to WhatsApp. If the process stops, those connections drop.

---

## 0. Pre-flight (5 min)

- [ ] Point a DNS **A record** for the API domain at the VM. If you use a Cloudflare tunnel instead, the tunnel creates the DNS record for you.
- [ ] Have a **VM** ready: Ubuntu 22.04 or 24.04 with 2 vCPU and 4 GB RAM to start.
  - Plan roughly 20–50 MB of RAM per linked number. This is an estimate, so measure it during the pilot.
  - The VM must be allowed to make outbound connections to `*.whatsapp.net` on port 443.
- [ ] Have a **MongoDB Atlas** cluster with a database user.
  - Allow the VM's IP under Network Access.
  - Copy the connection string.
- [ ] Get access to the **GHL Marketplace developer portal** for the agency account that will own the app.

---

## 1. Create the app in the GHL Marketplace (15 min)

Go to **Marketplace → My Apps → Create App**.

**Basic info**
- **App type:** Public, or Private while piloting.
- **Distribution:** **Agency & Sub-account.** Agency install must be allowed, because the agency token is what creates tokens for each sub-account.
- **Listing name, logo and description:** brand it as your own product. Never use "WhatsApp" as the brand name.

**Auth → Scopes.** Enable exactly these. They must match `SCOPES` in `backend/src/auth/auth.router.js`.
```
conversations.readonly  conversations.write
conversations/message.readonly  conversations/message.write
contacts.readonly  contacts.write
locations.readonly  locations/customFields.readonly  locations/customFields.write
users.readonly  oauth.readonly  oauth.write  marketplace-installer-details.readonly
```

**Auth → Redirect URL:** `https://whatsappapi.vaultsuite.store/auth/callback`

**Auth → Client keys:** create a key pair. Copy the **Client ID** and **Client Secret**; they become env vars in step 2.

**Shared secret (SSO key):** under Advanced Settings → Auth, generate the **Shared Secret**. It becomes `GHL_SSO_KEY`.

**Webhooks:** set the default webhook URL to `https://whatsappapi.vaultsuite.store/webhooks/ghl`. Enable these events:
- `INSTALL`, `UNINSTALL`, `UPDATE` / `APP_UPDATE`
- `PLAN_CHANGE`, `APP_PAYMENT_STATUS` (only if you charge through marketplace plans)

**Conversation provider** (Modules → Conversation Providers → Add):
- **Type:** `Custom`. Alternatively choose `SMS` if you want WhatsApp to replace SMS; then set `GHL_MESSAGE_TYPE=SMS`.
- **Name:** the channel name your users will see, e.g. "WhatsApp".
- **Delivery URL:** `https://whatsappapi.vaultsuite.store/webhooks/ghl-outbound`
- Save, then copy the **Conversation Provider ID**. It becomes `GHL_CONVERSATION_PROVIDER_ID`.

**Second conversation provider: WhatsApp Voice** (Modules → Conversation Providers → Add):
- **Type:** `Call`
- **Name:** `WhatsApp Voice`
- **Delivery URL:** `https://whatsappapi.vaultsuite.store/webhooks/ghl-call`
- Copy its ID into `GHL_CALL_PROVIDER_ID`.

WhatsApp calls are logged under this provider: answered on the phone, declined, or missed. Linked devices can't carry call audio, so a call started from the CRM dialer is marked failed, with a note to call from the phone instead.

**Custom pages** (Modules → Custom Pages). Create **two**, both pointing at the UI:
- **Agency-level page:** URL `https://whatsapp.vaultsuite.store`, shown in the agency left menu
- **Sub-account page:** URL `https://whatsapp.vaultsuite.store`, shown in each sub-account's left menu

The app reads the logged-in user's context and shows either the agency console or the sub-account page.

**Pricing** (if charging): create your plans, for example Starter, Growth and Scale. Copy each **plan ID** for `PLANS_JSON` in step 2, along with how many numbers each plan allows.

**Workflow triggers** (Modules → Workflows → Triggers). Add each one, keyed exactly as shown:
- **Subscription URL** for every trigger: `https://whatsappapi.vaultsuite.store/workflows/triggers/subscriptions`
- **Payload fields** below must be declared for each trigger.
- **Message fields** = `contactId, locationId, messageText, messageType, whatsappId, phone, contactName, linkedNumber, linkedNumberLabel, attachmentUrl, timestamp`

| Key | Name shown in GHL | Payload fields to declare |
|---|---|---|
| `whatsapp_message_received` | WhatsApp message received | message fields |
| `whatsapp_new_contact` | New WhatsApp contact | message fields |
| `whatsapp_media_received` | WhatsApp media received | message fields |
| `whatsapp_phone_reply` | Reply sent from phone | message fields |
| `whatsapp_keyword_received` | WhatsApp keyword received | message fields + `keyword, ruleName, ruleId, matchType` |
| `whatsapp_message_failed` | WhatsApp message failed | `contactId, messageText, errorMessage, errorCode, timestamp` |
| `whatsapp_number_disconnected` | WhatsApp number disconnected | `sessionId, reason, timestamp` |
| `whatsapp_contact_opted_out` | Contact unsubscribed | `contactId, phone, contactName, status, previousStatus, method, keyword, messageText, linkedNumber, timestamp` |
| `whatsapp_contact_opted_in` | Contact re-subscribed | same as opted out |
| `whatsapp_call_received` | WhatsApp call received | `contactId, phone, callStatus (answered/declined/missed), isVideo, linkedNumber, timestamp` |
| `whatsapp_group_message_received` | WhatsApp group message | `contactId, groupJid, groupName, senderName, senderPhone, messageText, messageType, linkedNumber, attachmentUrl, timestamp` |

**Workflow actions** (Modules → Workflows → Actions):

| Key | URL (`POST`) | Input fields |
|---|---|---|
| `whatsapp_send_message` | `/workflows/actions/send-message` | `message` (text), `numberId` (optional) |
| `whatsapp_send_media` | `/workflows/actions/send-media` | `mediaUrl`, `caption` (optional), `numberId` (optional) |
| `whatsapp_send_template` | `/workflows/actions/send-template` | `templateName` or `templateId`, `numberId` (optional) |
| `whatsapp_send_to_number` | `/workflows/actions/send-to-number` | `phone`, `message`, `mediaUrl` (optional) |
| `whatsapp_send_to_group` | `/workflows/actions/send-to-group` | `groupName` or `groupJid`, `message`, `mediaUrl` (optional) |
| `whatsapp_check_number` | `/workflows/actions/check-number` | `phone` (optional; defaults to the contact's phone) → returns `onWhatsApp: yes/no` |
| `whatsapp_opt_in_contact` | `/workflows/actions/opt-in-contact` | `note` (optional) |
| `whatsapp_opt_out_contact` | `/workflows/actions/opt-out-contact` | `note` (optional) |

Every URL above is prefixed with `https://whatsappapi.vaultsuite.store`.

**Webhook signature key:** copy GHL's **Ed25519 public key** from the marketplace webhook docs. It becomes `GHL_WEBHOOK_ED25519_PUBLIC_KEY`.

---

## 2. Deploy the API (20 min)

### 2.1 Server setup (once)

```bash
# On the VM, as a sudo user
sudo apt update && sudo apt install -y nginx git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
node -v   # must be v22.12 or newer (the WhatsApp library needs it)
sudo npm i -g pm2
pm2 install pm2-logrotate        # keeps logs from filling the disk
```

### 2.2 Get the code onto the server

```bash
sudo mkdir -p /opt/whatsapp-connector && sudo chown $USER /opt/whatsapp-connector
# Option A: git (once the repo has a remote)
git clone <your-repo-url> /opt/whatsapp-connector
# Option B: copy from your Mac
rsync -av --exclude node_modules --exclude .env --exclude tmp \
  ~/Desktop/marketplace/whatsapp/ user@vm:/opt/whatsapp-connector/

cd /opt/whatsapp-connector/backend && npm ci --omit=dev
```

### 2.3 Create `backend/.env`

Start from `backend/.env.example`. Required values:

| Variable | Value / how to get it |
|---|---|
| `DATABASE_URL` | Atlas connection string, for example `mongodb+srv://user:pass@cluster/whatsapp-connector` |
| `PORT` | `3025` |
| `BACKEND_URL` | `https://whatsappapi.vaultsuite.store` |
| `FRONTEND_URL` | `https://whatsapp.vaultsuite.store`. **Required** for share-to-connect links (`/connect/<token>`). |
| `INSTANCE_ID` | `wa-api-1`. Must be unique per running process. |
| `ENCRYPTION_KEY` | `openssl rand -hex 32`. **Back it up.** If you lose it, every linked number has to be re-scanned. |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `ALLOW_DEV_LOGIN` | `false` in production. **Never `true`.** |
| `GHL_CLIENT_ID` / `GHL_CLIENT_SECRET` | from step 1 |
| `GHL_REDIRECT_URI` | `https://whatsappapi.vaultsuite.store/auth/callback` |
| `GHL_SSO_KEY` | the Shared Secret from step 1 |
| `GHL_APP_ID` | your app ID (it's in the marketplace app URL) |
| `GHL_CONVERSATION_PROVIDER_ID` | from step 1 (the **WhatsApp**, SMS-type provider) |
| `GHL_CALL_PROVIDER_ID` | from step 1 (the **WhatsApp Voice**, Call-type provider). If empty, calls are logged as a text line instead. |
| `GHL_API_BASE` | `https://services.leadconnectorhq.com` |
| `GHL_API_VERSION` | `2021-07-28` |
| `GHL_MESSAGE_TYPE` | `Custom`, or `SMS` if you registered the provider as SMS |
| `GHL_WEBHOOK_ED25519_PUBLIC_KEY` | from step 1. Paste it on one line, with real line breaks replaced by `\n`. |
| `GHL_WEBHOOK_VERIFY_MODE` | Start with `monitor`, then switch to `enforce` (see §5). |
| `SUBSCRIPTION_REQUIRED` | `true` if you charge through marketplace plans |
| `TRIAL_DAYS` | `3` |
| `PLANS_JSON` | `{"<planId>":{"name":"Starter","priceUsd":29,"numberLimit":1},…}` using the real plan IDs from step 1 |
| `GHL_DEFAULT_APP_DOMAIN` | `app.gohighlevel.com` |
| `GHL_APP_VERSION_ID` | the app's current version ID (used for "Choose plan" links) |
| `WA_DEFAULT_MIN_DELAY_MS` / `WA_DEFAULT_DAILY_LIMIT` | `1500` / `1000` (safe defaults) |
| `WA_RESTORE_CONCURRENCY` / `WA_SEND_WAIT_MS` | `5` / `20000`. After a restart, numbers reconnect at most 5 at a time, most recently active first, and replies for a number that is still reconnecting wait up to 20 s instead of failing. |
| `BAILEYS_LOG_LEVEL` | `silent`, or `warn` while debugging |
| `ADMIN_API_KEY` | `openssl rand -hex 24` (for `/admin/stats`) |
| `PROXY_POOL_JSON` | Optional. Proxies per country, for example `{"GB":["http://user:pass@gb1.example:8000"],"IN":["socks5://u:p@in1.example:1080"]}`. Each number can pick a country in its settings. Leave it empty for direct connections. |

```bash
chmod 600 /opt/whatsapp-connector/backend/.env
```

### 2.4 Start it with pm2

```bash
cd /opt/whatsapp-connector
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup          # run the command it prints, so pm2 restarts on reboot
pm2 logs whatsapp --lines 30
```

You should see:
```
Connected to MongoDB
[features] loaded: consent, rules, groups, analytics
WhatsApp Connector API on :3025 (wa-api-1)
[WA] restoring 0 session(s) on wa-api-1
```

> **Never use `pm2 start … -i max` or cluster mode.** Running more than one process per `INSTANCE_ID` makes WhatsApp log the numbers out.

### 2.5 Put HTTPS in front of it

Choose one option.

**Option A: nginx + Let's Encrypt**
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/whatsappapi
sudo sed -i 's/whatsappapi.vaultsuite.store/<your-api-domain>/' /etc/nginx/sites-available/whatsappapi
sudo ln -s /etc/nginx/sites-available/whatsappapi /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d <your-api-domain>
```
The included config turns off buffering for `/api/live`. Without that, QR codes wouldn't update live.

**Option B: Cloudflare tunnel** (the same approach as the Deal Hub server, no open ports needed)
```bash
cloudflared tunnel create whatsapp-api
cloudflared tunnel route dns whatsapp-api <your-api-domain>
# ~/.cloudflared/config.yml → ingress: - hostname: <your-api-domain>  service: http://localhost:3025
sudo cloudflared service install
```

### 2.6 Check it

```bash
curl https://whatsappapi.vaultsuite.store/health
# {"status":"ok","instance":"wa-api-1","sessions":0}
curl -X POST https://whatsappapi.vaultsuite.store/auth/dev
# must be 404 in production (dev login disabled)
```

---

## 3. Deploy the UI on Vercel (5 min)

1. Vercel → **Add New Project** → import the repo. Set **Root Directory** to `frontend`.
2. The framework is detected as Vite. `frontend/vercel.json` already sets the build command, the output directory, and headers that allow the page to be embedded in the CRM.
3. **Environment variable:** `VITE_API_BASE` = `https://whatsappapi.vaultsuite.store`. Do **not** set `VITE_ALLOW_DEV`.
4. Deploy, then add your domain (`whatsapp.vaultsuite.store`) under Settings → Domains.

If you don't use git, you can deploy from your Mac instead:
```bash
cd ~/Desktop/marketplace/whatsapp/frontend
npx vercel --prod      # first run links the project; set VITE_API_BASE in the Vercel dashboard
```

---

## 4. First live test (15 min). Do this before anyone else installs.

Use a test agency and test sub-account, and a spare phone number. Don't use a number your business depends on.

1. **Install as agency.** Marketplace listing → Install → choose the agency.
   - **Expect:** a "Installed successfully" page, and the API logs show `company install stored` and `synced N sub-accounts`.
2. **Agency console.** Agency menu → your app.
   - **Expect:** every sub-account listed. Switch one on.
3. **Link a number.** Sub-account menu → your app → **Link a number** → scan the QR with the spare phone (WhatsApp → Linked devices → Link a device).
   - **Expect:** "Number linked", and the card shows **Connected**.
4. **Inbound.** From another phone, send a WhatsApp message to the linked number.
   - **Expect:** a contact is created or matched, and the message appears in **Conversations** within a few seconds.
5. **Outbound.** Reply from Conversations, choosing the WhatsApp channel.
   - **Expect:** the other phone receives it, and the message status in GHL changes to delivered, then read.
6. **Reply from the phone.** Reply directly in the WhatsApp app on the linked phone.
   - **Expect:** the reply is mirrored into Conversations.
7. **Opt-out.** From the other phone, send `STOP`.
   - **Expect:** a confirmation reply, the contact shows *Opted out* on the Consent tab, and replies from the CRM now fail with "contact unsubscribed".
   - Send `START` to opt back in.
8. **Auto-reply.** Auto-replies tab → add the starter "C to confirm" rule. Send `C` from the other phone.
   - **Expect:** an instant reply.
9. **Workflow.** Create a workflow with the trigger "WhatsApp message received" and the action "Send WhatsApp message".
   - **Expect:** it fires end to end.
10. **Restart.** Run `pm2 restart whatsapp`.
    - **Expect:** the number reconnects by itself within about 10 seconds, with no new scan.
11. **Unlink.** Number card → Unlink.
    - **Expect:** the device disappears from the phone's Linked devices list.
12. **Share link.** Number card → Share link → copy it → open it on another device.
    - **Expect:** the client can scan the QR there with no CRM login, and the number appears in the sub-account.
13. **Routing.** With two numbers linked, send `{WA#2} hello` from Conversations.
    - **Expect:** it goes out from WhatsApp #2, and the `{WA#2}` token is removed from the message.

If any step fails, check `pm2 logs whatsapp`. Every GHL call that fails is logged with its status code and response body.

---

## 5. Hardening before going public

- [ ] **Turn webhook signature checks on.** After a day of `monitor` mode with no `signature not verified` lines in the logs, set `GHL_WEBHOOK_VERIFY_MODE=enforce` and run `pm2 restart whatsapp`.
- [ ] **Store `ENCRYPTION_KEY` in a password manager.** Atlas backups are useless without it.
- [ ] **Turn on Atlas backups** (continuous or daily).
- [ ] **Uptime monitor** on `/health`, alerting if it is down for more than 2 minutes.
- [ ] **Watch the session count.** `curl -H "X-Admin-Key: $ADMIN_API_KEY" https://…/admin/stats` returns the number of sessions in each status. A spike in `logged_out` or `banned` means sending is too aggressive.
- [ ] **Policy check.** Confirm with GHL that a QR-linked WhatsApp app is acceptable for a public listing.
- [ ] **Sending pace.** Keep the agency defaults at or above 1500 ms between messages and at or below 1000 messages per day per number.

---

## 6. Updating

```bash
cd /opt/whatsapp-connector && git pull        # or rsync again from your Mac
cd backend && npm ci --omit=dev
pm2 reload whatsapp             # graceful: links are kept, sessions reconnect
```
The UI redeploys on its own when you push, or run `npx vercel --prod`.

**Rollback:**
```bash
git checkout <previous-tag> && cd backend && npm ci --omit=dev && pm2 reload whatsapp
```
Data is backward compatible; no migrations are needed.

**Upgrading Baileys** (the WhatsApp library, pinned to `6.7.24`):
1. Bump the version on a staging VM first.
2. Run the §4 checklist.
3. Then roll it out to production.

---

## 7. Scaling past one server

One VM should handle a few hundred numbers. That's an estimate; confirm it with the RAM you see during the pilot. To add a second one:
1. Give it its own `INSTANCE_ID` (for example `wa-api-2`) and the **same** `DATABASE_URL` and `ENCRYPTION_KEY`.
2. Put both behind the load balancer. Sessions are leased per instance, so any instance can serve the API, but each number's socket runs on exactly one of them.

**Known gap:** a message sent from the CRM must reach the instance that holds that number's socket. Before running more than one instance, add routing so the sending instance can reach the owning one. This is not built yet; until it is, run a single API instance and scale it vertically.
