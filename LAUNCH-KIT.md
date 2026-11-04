# Greenline for WhatsApp: launch kit

## 1. App name
**Greenline for WhatsApp**
- Green is WhatsApp's colour, and "line" means a business phone line.
- The "for WhatsApp" wording is the safe way to include the trademark: it describes what the app connects to without claiming the WhatsApp brand.
- Avoid "Greenline WhatsApp" (the two names fused together) and never use the WhatsApp logo.

## 2. Logo
- **Chosen:** `brand/icon-c-512.png`. It is 512×512 px, about 29 KB, with a transparent background, inside GHL's limits of 400–800 px and 500 KB. The source file is `brand/icon-c.svg`.
- Design: a green rounded tile (`#1FB25C` to `#0A6B34`) with a central WhatsApp-style bubble and handset, plus a small dark-green Greenline badge (a chat bubble with two lines) in the bottom-right corner.
- The central mark resembles WhatsApp's logo. If GHL or Meta object, fall back to `icon-b-512.png` (Greenline mark with a small WhatsApp badge) or `icon-512.png` (no WhatsApp element).
- Alternatives kept in `brand/`: `icon-a` (WhatsApp-style mark only), `icon-b`, and `icon` (original).

## 3. Category
- **Primary:** Communication (or Messaging, whichever exists in the dropdown)
- **Secondary:** CRM / Conversations

## 4. Tagline
Recommended: **Link your WhatsApp in 30 seconds. Chat from your CRM.** (53 characters)

Alternatives:
- Every WhatsApp chat, synced to your CRM inbox. (45)
- Two-way WhatsApp in Conversations. Just scan a QR. (50)

## 5. Business niche
Agencies and SaaS resellers whose clients sell on WhatsApp (clinics, gyms, real estate, home services). They want to reply from the CRM on the number they already use, without Meta Business API verification, template approvals or per-conversation fees. The agency controls which sub-accounts get it.

Dropdown choice: **Marketing Agency**. If the dropdown only lists verticals, choose the closest general option.

## 7. Keywords
whatsapp, whatsapp crm, whatsapp integration, two-way whatsapp, whatsapp inbox, whatsapp qr, whatsapp automation, whatsapp auto reply, whatsapp groups, agency whatsapp

## Listing description (for Listing Configuration)
Connect the WhatsApp number your business already uses by scanning a QR code, the same way WhatsApp Web works. Customer messages land in Conversations, your team replies from the CRM, and workflows can send WhatsApp messages automatically.

- **Two-way sync:** text, photos, voice notes, documents, and replies sent from the phone
- **Agency control:** choose which sub-accounts can use WhatsApp, cap numbers per account, or scan the QR on a client's behalf
- **Auto-replies:** keyword rules ("Reply C to confirm"), templates with `{{first_name}}`, away hours and welcome messages
- **Consent built in:** STOP/START opt-out with a full audit log
- **WhatsApp groups**, delivery and read receipts, and analytics
- **10 workflow triggers and 8 actions**
- **Safe sending:** messages are paced automatically to protect your number

## Upload checklist (GHL → Build → Profile)
- [ ] Basic Info → App name: `Greenline for WhatsApp`
- [ ] Basic Info → App logo: `brand/icon-c-512.png`
- [ ] Basic Info → Category / Tagline / Business niche / Company (`EnrichFlow Labs`)
- [ ] Listing Configuration → description above + keywords
- [ ] Support Details → support email + help-site URL (pending: marketing site)
- [ ] Getting Started Guide → steps from DEPLOY.md §4 (install → enable → scan QR)
