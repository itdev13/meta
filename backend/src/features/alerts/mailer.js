const axios = require('axios');
const nodemailer = require('nodemailer');
const logger = require('../../utils/logger');

/**
 * Outbound email for alerts. First match wins:
 *   1. BREVO_API_KEY                      — Brevo HTTP API (same as ConvoVault). Sends from
 *                                           ALERT_FROM_EMAIL (default support@vaultsuite.store, verified in Brevo).
 *   2. SMTP_USER + SMTP_PASS (+ SMTP_HOST/PORT) — Gmail app password, or any SMTP provider.
 * ALERT_FROM_NAME sets the display name (default "Greenline for WhatsApp").
 * ALERT_CC (comma-separated) gets a hidden copy of every alert email, for the app owner.
 */
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_FROM = 'support@vaultsuite.store';

function fromEmail() {
  return process.env.ALERT_FROM_EMAIL || DEFAULT_FROM;
}

function ownerCopies() {
  return String(process.env.ALERT_CC || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

let transport = null;
let checked = false;

function provider() {
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  return null;
}

function configured() {
  return !!provider();
}

function fromName() {
  return process.env.ALERT_FROM_NAME || `${process.env.APP_NAME || 'Greenline'} for WhatsApp`;
}

function getTransport() {
  if (checked) return transport;
  checked = true;
  const auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
  transport = process.env.SMTP_HOST
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
        auth,
      })
    : nodemailer.createTransport({ service: 'gmail', auth });
  transport
    .verify()
    .then(() => logger.info('✉️ Alert email ready', { via: process.env.SMTP_HOST || 'gmail' }))
    .catch((err) => logger.error('✉️ Alert email login failed', { error: err.message }));
  return transport;
}

async function sendBrevo(list, { subject, html, text }) {
  const sender = { name: fromName(), email: fromEmail() };
  try {
    // BCC so sub-account and agency recipients don't see each other's addresses.
    const { data } = await axios.post(
      BREVO_URL,
      { sender, to: [sender], bcc: list.map((email) => ({ email })), subject, htmlContent: html, textContent: text },
      { headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': process.env.BREVO_API_KEY }, timeout: 15000 },
    );
    return { sent: list.length, id: data?.messageId };
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    throw new Error(`Brevo: ${detail}`);
  }
}

async function sendSmtp(list, { subject, html, text }) {
  const from = `"${fromName()}" <${process.env.ALERT_FROM_EMAIL || process.env.SMTP_USER}>`;
  await getTransport().sendMail({ from, to: from, bcc: list, subject, html, text });
  return { sent: list.length };
}

let warned = false;
async function sendMail({ to, subject, html, text }) {
  const via = provider();
  if (!via) {
    if (!warned) logger.warn('✉️ Alert email disabled — set BREVO_API_KEY, or SMTP_USER + SMTP_PASS');
    warned = true;
    return { skipped: 'not_configured' };
  }
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { skipped: 'no_recipients' };
  // Owner copy rides in BCC too, so customers never see it. Not counted in `sent`.
  const list = [...new Set([...recipients, ...ownerCopies()])];
  const sent = new Set(recipients).size;
  const r = via === 'brevo' ? await sendBrevo(list, { subject, html, text }) : await sendSmtp(list, { subject, html, text });
  return { ...r, sent };
}

module.exports = { sendMail, configured };
