/** WhatsApp address helpers. */

const PN_SUFFIX = '@s.whatsapp.net';

function digits(v) {
  return String(v || '').replace(/[^\d]/g, '');
}

/** "+91 99999-99999" → "919999999999@s.whatsapp.net" (uses DEFAULT_PHONE_COUNTRY_CODE for local numbers). */
function phoneToJid(phone) {
  let d = digits(phone);
  if (!d) return null;
  const cc = digits(process.env.DEFAULT_PHONE_COUNTRY_CODE);
  if (cc && d.length <= 10 && !String(phone).trim().startsWith('+')) d = cc + d.replace(/^0+/, '');
  return `${d}${PN_SUFFIX}`;
}

/** Strip device suffix: "9199...:12@s.whatsapp.net" → "9199...@s.whatsapp.net". */
function normalizeJid(jid) {
  if (!jid) return null;
  const [user, server] = String(jid).split('@');
  if (!server) return null;
  return `${user.split(':')[0]}@${server}`;
}

function isPnJid(jid) {
  return !!jid && String(jid).endsWith(PN_SUFFIX);
}

function isLidJid(jid) {
  return !!jid && String(jid).endsWith('@lid');
}

function isGroupJid(jid) {
  return !!jid && String(jid).endsWith('@g.us');
}

/** Status updates, broadcast lists and channels are never conversations. */
function isIgnorableJid(jid) {
  const j = String(jid || '');
  return !j || j === 'status@broadcast' || j.endsWith('@broadcast') || j.endsWith('@newsletter');
}

/** "120363...@g.us" | "120363..." | "1555...-1600..." → "<id>@g.us"; anything else → null. */
function toGroupJid(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  if (isGroupJid(raw)) return normalizeJid(raw);
  if (/^[\d-]{10,}$/.test(raw)) return `${raw}@g.us`;
  return null;
}

function jidToPhone(jid) {
  if (!isPnJid(jid)) return '';
  return `+${String(jid).split('@')[0].split(':')[0]}`;
}

module.exports = { phoneToJid, normalizeJid, isPnJid, isLidJid, isGroupJid, isIgnorableJid, jidToPhone, toGroupJid, digits };
