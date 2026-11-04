const crypto = require('crypto');
const CryptoJS = require('crypto-js');

/**
 * AES-256-GCM for encrypting tokens/sessions at rest, plus CryptoJS AES for decrypting
 * GHL SSO payloads. Tokens, WhatsApp creds and signal keys are all stored
 * encrypted at rest.
 */
class CryptoService {
  constructor() {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) throw new Error('ENCRYPTION_KEY is required');
    this.encryptionKey = Buffer.from(key, 'hex');
  }

  // ── AES-256-GCM for database field encryption ──────────────

  encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  decrypt(ciphertext) {
    const [ivHex, authTagHex, encrypted] = ciphertext.split(':');

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // ── CryptoJS AES decryption for GHL SSO payloads ──────────

  decryptSsoPayload(encryptedPayload) {
    const ssoKey = process.env.GHL_SSO_KEY;
    if (!ssoKey) throw new Error('GHL_SSO_KEY is required');

    const decrypted = CryptoJS.AES.decrypt(encryptedPayload, ssoKey).toString(CryptoJS.enc.Utf8);

    if (!decrypted) {
      throw new Error('SSO decryption failed: empty result');
    }

    return JSON.parse(decrypted);
  }

  // ── Generate random secrets ────────────────────────────────

  generateWebhookSecret() {
    return crypto.randomBytes(32).toString('hex');
  }
}

module.exports = CryptoService;
