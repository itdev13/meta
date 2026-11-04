const crypto = require('crypto');

// GoHighLevel webhook signature verification.
// Source: https://marketplace.gohighlevel.com/docs/2021-04-15/webhook/WebhookIntegrationGuide
//
// Two schemes during the transition (both headers may be present until 2026-09-01):
//   - X-GHL-Signature  → Ed25519 (new, preferred)
//   - X-WH-Signature    → RSA-SHA256 (legacy, deprecated 2026-09-01)
// We prefer the Ed25519 signature and fall back to legacy only if the new one is absent.
// Both keys are overridable via env in case GHL rotates them, without a redeploy.

// Ed25519 public key for X-GHL-Signature — supplied via env (no hardcoded fallback).
const GHL_PUBLIC_KEY = (process.env.GHL_WEBHOOK_ED25519_PUBLIC_KEY || '').replace(/\\n/g, '\n');

const LEGACY_PUBLIC_KEY =
  process.env.GHL_WEBHOOK_LEGACY_PUBLIC_KEY ||
  `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

// 'enforce' → reject unverified requests with 401.
// 'monitor' (default) → log failures but let the request through (safe rollout;
//   flip to 'enforce' once logs confirm real GHL traffic verifies cleanly).
const MODE = process.env.GHL_WEBHOOK_VERIFY_MODE || 'monitor';

// Ed25519 (new)
function verifyGhl(payload, signature) {
  if (!signature || signature === 'N/A') return { ok: false, reason: 'no signature' };
  if (!GHL_PUBLIC_KEY) return { ok: false, reason: 'GHL_WEBHOOK_ED25519_PUBLIC_KEY not set' };
  try {
    const ok = crypto.verify(
      null,
      Buffer.from(payload, 'utf8'),
      GHL_PUBLIC_KEY,
      Buffer.from(signature, 'base64'),
    );
    return { ok, reason: ok ? null : 'ed25519 verify failed' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// RSA-SHA256 (legacy)
function verifyLegacy(payload, signature) {
  if (!signature || signature === 'N/A') return { ok: false, reason: 'no signature' };
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(payload);
    const ok = verifier.verify(LEGACY_PUBLIC_KEY, signature, 'base64');
    return { ok, reason: ok ? null : 'rsa verify failed' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Verify a GHL webhook. Prefers the Ed25519 X-GHL-Signature; falls back to the
 * legacy RSA X-WH-Signature only when the new header is absent.
 */
function verifyGhlSignature(req) {
  const payload = JSON.stringify(req.body);
  const ghlSig = req.get('X-GHL-Signature');
  const legacySig = req.get('X-WH-Signature');
  if (ghlSig) return { ...verifyGhl(payload, ghlSig), scheme: 'ed25519' };
  if (legacySig) return { ...verifyLegacy(payload, legacySig), scheme: 'legacy-rsa' };
  return { ok: false, reason: 'no signature header', scheme: 'none' };
}

/**
 * Express middleware for GHL webhook routes. In 'monitor' mode it never blocks —
 * it only logs — so a serialization mismatch can't drop real webhooks during
 * rollout. In 'enforce' mode it 401s unverified requests.
 */
function ghlSignatureGuard(req, res, next) {
  const { ok, reason, scheme } = verifyGhlSignature(req);
  if (ok) return next();

  if (MODE === 'enforce') {
    console.warn(`[Webhook] REJECTED GHL webhook on ${req.originalUrl} — ${scheme}: ${reason}`);
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  console.warn(`[Webhook] (monitor) GHL signature not verified on ${req.originalUrl} — ${scheme}: ${reason}`);
  return next();
}

module.exports = {
  verifyGhlSignature,
  ghlSignatureGuard,
  GHL_WEBHOOK_VERIFY_MODE: MODE,
};
