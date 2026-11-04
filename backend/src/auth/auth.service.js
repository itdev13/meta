const axios = require('axios');
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');
const Installation = require('../schemas/installation.schema');
const OAuthToken = require('../schemas/oauth-token.schema');
const CompanyLocation = require('../schemas/company-location.schema');
const { formatError } = require('../utils/format-error');

/**
 * OAuth + token lifecycle + embedded-UI sessions.
 *
 * Tokens: oauth_tokens holds 'location' tokens (per sub-account) and 'company' tokens (agency
 * install). Location tokens are minted lazily from the company token, so an agency that installs
 * once covers every sub-account. Refresh handles the invalid_grant race between processes.
 *
 * Sessions: the GHL SSO blob is decrypted ONCE at /auth/session and exchanged for a short JWT
 * carrying the scope ('agency' | 'location'). Every API call then just verifies the JWT.
 */
class AuthService {
  constructor(cryptoService) {
    this.crypto = cryptoService;
    this.ghlApiBase = process.env.GHL_API_BASE;
    this.apiVersion = process.env.GHL_API_VERSION || '2021-07-28';
    if (!this.ghlApiBase) throw new Error('GHL_API_BASE is required');
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
    this._minting = new Map(); // locationId → in-flight mint promise (dedupe concurrent mints)
  }

  // ── OAuth callback ───────────────────────────────────────────

  async handleOAuthCallback(code) {
    let tokenResponse;
    try {
      tokenResponse = await axios.post(
        `${this.ghlApiBase}/oauth/token`,
        new URLSearchParams({
          client_id: process.env.GHL_CLIENT_ID,
          client_secret: process.env.GHL_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: process.env.GHL_REDIRECT_URI,
        }),
      );
    } catch (error) {
      logger.error('❌ OAuth token exchange failed', { error: formatError(error) });
      throw error;
    }

    const { access_token, refresh_token, expires_in, locationId, companyId } = tokenResponse.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    if (locationId) {
      await this._storeLocationToken({ locationId, companyId, access_token, refresh_token, expiresAt });
      await this._ensureInstallation(locationId, companyId);
      if (companyId) {
        await CompanyLocation.updateOne({ companyId }, { $addToSet: { locationIds: locationId } }, { upsert: true });
      }
      logger.info('🔑 OAuth install: sub-account connected', { locationId, companyId });
      return { locationId, companyId, scope: 'location' };
    }

    if (companyId) {
      await OAuthToken.findOneAndUpdate(
        { companyId, tokenType: 'company' },
        {
          companyId,
          tokenType: 'company',
          accessToken: this.crypto.encrypt(access_token),
          refreshToken: this.crypto.encrypt(refresh_token),
          expiresAt,
          isActive: true,
        },
        { upsert: true, new: true },
      );
      logger.info('🔑 OAuth install: agency connected', { companyId });
      try {
        await this.syncCompanyLocations(companyId, access_token);
      } catch (error) {
        console.error(`[Auth] company location sync failed for ${companyId} | ${formatError(error)}`);
      }
      return { companyId, scope: 'company' };
    }

    throw new Error('OAuth response missing both locationId and companyId');
  }

  async _storeLocationToken({ locationId, companyId, access_token, refresh_token, expiresAt }) {
    await OAuthToken.findOneAndUpdate(
      { locationId, tokenType: 'location' },
      {
        locationId,
        companyId: companyId || '',
        tokenType: 'location',
        accessToken: this.crypto.encrypt(access_token),
        refreshToken: this.crypto.encrypt(refresh_token),
        expiresAt,
        isActive: true,
      },
      { upsert: true, new: true },
    );
  }

  async _ensureInstallation(locationId, companyId) {
    await Installation.findOneAndUpdate(
      { locationId },
      {
        $set: { companyId: companyId || '', locationId, status: 'active' },
        $unset: { uninstalledAt: '' },
        $setOnInsert: { installedAt: new Date(), conversationProviderId: process.env.GHL_CONVERSATION_PROVIDER_ID || '' },
      },
      { upsert: true },
    );
  }

  // ── Agency directory ─────────────────────────────────────────

  /**
   * Pull every sub-account of the agency (paginated) into CompanyLocation. Called on company
   * install and from the agency dashboard's "Refresh" button.
   */
  async syncCompanyLocations(companyId, accessToken) {
    const token = accessToken || (await this.getCompanyAccessToken(companyId));
    const all = [];
    const limit = 100;
    for (let skip = 0; skip < 10000; skip += limit) {
      const res = await axios.get(`${this.ghlApiBase}/locations/search`, {
        params: { companyId, limit, skip },
        headers: { Authorization: `Bearer ${token}`, Version: this.apiVersion },
      });
      const page = res.data.locations || [];
      all.push(...page);
      if (page.length < limit) break;
    }

    const locations = all.map((l) => ({
      id: l.id,
      name: l.name || '',
      email: l.email || '',
      phone: l.phone || '',
      city: l.city || '',
      country: l.country || '',
      logoUrl: l.logoUrl || '',
    }));

    await CompanyLocation.findOneAndUpdate(
      { companyId },
      { $set: { companyId, locations, locationIds: locations.map((l) => l.id), syncedAt: new Date() } },
      { upsert: true },
    );

    // A company (re)install covers every sub-account → reactivate any marked uninstalled.
    if (locations.length) {
      await Installation.updateMany(
        { locationId: { $in: locations.map((l) => l.id) }, status: 'uninstalled' },
        { $set: { status: 'active', companyId }, $unset: { uninstalledAt: '' } },
      );
    }
    logger.info('🏢 Agency sub-accounts synced', { companyId, subAccounts: locations.length });
    return locations;
  }

  async locationBelongsToCompany(companyId, locationId) {
    if (!companyId || !locationId) return false;
    const hit = await CompanyLocation.exists({ companyId, locationIds: locationId });
    if (hit) return true;
    const inst = await Installation.exists({ companyId, locationId });
    return !!inst;
  }

  // ── Company token ────────────────────────────────────────────

  async getCompanyAccessToken(companyId) {
    const companyToken = await OAuthToken.findActiveCompanyToken(companyId);
    if (!companyToken) {
      const err = new Error(`No active company token for company: ${companyId}`);
      err.statusCode = 401;
      err.code = 'NO_COMPANY_TOKEN';
      throw err;
    }
    if (companyToken.needsRefresh()) return this._refreshCompanyToken(companyId);
    return this.crypto.decrypt(companyToken.accessToken);
  }

  async hasCompanyToken(companyId) {
    return !!(await OAuthToken.exists({ companyId, tokenType: 'company', isActive: true }));
  }

  async _refreshCompanyToken(companyId) {
    const companyToken = await OAuthToken.findOne({ companyId, tokenType: 'company' });
    if (!companyToken) {
      const err = new Error(`No company token for: ${companyId}`);
      err.statusCode = 401;
      throw err;
    }
    try {
      const res = await axios.post(
        `${this.ghlApiBase}/oauth/token`,
        new URLSearchParams({
          client_id: process.env.GHL_CLIENT_ID,
          client_secret: process.env.GHL_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: this.crypto.decrypt(companyToken.refreshToken),
        }),
      );
      const { access_token, refresh_token, expires_in } = res.data;
      await OAuthToken.updateOne(
        { companyId, tokenType: 'company' },
        {
          accessToken: this.crypto.encrypt(access_token),
          refreshToken: this.crypto.encrypt(refresh_token),
          expiresAt: new Date(Date.now() + expires_in * 1000),
          isActive: true,
        },
      );
      return access_token;
    } catch (error) {
      if (error?.response?.data?.error === 'invalid_grant') {
        // Another process may have just rotated it.
        const fresh = await OAuthToken.findOne({ companyId, tokenType: 'company' });
        if (fresh && fresh.accessToken !== companyToken.accessToken && !fresh.needsRefresh()) {
          return this.crypto.decrypt(fresh.accessToken);
        }
        await OAuthToken.updateOne({ companyId, tokenType: 'company' }, { isActive: false });
        logger.error('❌ Agency refresh token revoked — deactivated', { companyId });
      }
      throw error;
    }
  }

  async _mintLocationToken(companyId, locationId) {
    const accessToken = await this.getCompanyAccessToken(companyId);
    const res = await axios.post(
      `${this.ghlApiBase}/oauth/locationToken`,
      new URLSearchParams({ companyId, locationId }),
      { headers: { Authorization: `Bearer ${accessToken}`, Version: this.apiVersion } },
    );
    const { access_token, refresh_token, expires_in } = res.data;
    await this._storeLocationToken({
      locationId,
      companyId,
      access_token,
      refresh_token,
      expiresAt: new Date(Date.now() + expires_in * 1000),
    });
    logger.info('🔄 Location token generated from agency token', { locationId, companyId });
    return access_token;
  }

  // ── Location token ───────────────────────────────────────────

  async refreshAccessToken(locationId) {
    const token = await OAuthToken.findActiveToken(locationId);
    if (!token) {
      const err = new Error(`No token found for location: ${locationId}`);
      err.statusCode = 401;
      throw err;
    }
    try {
      const res = await axios.post(
        `${this.ghlApiBase}/oauth/token`,
        new URLSearchParams({
          client_id: process.env.GHL_CLIENT_ID,
          client_secret: process.env.GHL_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: this.crypto.decrypt(token.refreshToken),
        }),
      );
      const { access_token, refresh_token, expires_in } = res.data;
      await OAuthToken.updateOne(
        { locationId, tokenType: 'location' },
        {
          accessToken: this.crypto.encrypt(access_token),
          refreshToken: this.crypto.encrypt(refresh_token),
          expiresAt: new Date(Date.now() + expires_in * 1000),
        },
      );
      return access_token;
    } catch (error) {
      if (error?.response?.data?.error === 'invalid_grant') {
        const fresh = await OAuthToken.findActiveToken(locationId);
        if (fresh && fresh.accessToken !== token.accessToken) return this.crypto.decrypt(fresh.accessToken);
        // Refresh token dead: drop it so the next call re-mints from the company token (if any).
        await OAuthToken.updateOne({ locationId, tokenType: 'location' }, { isActive: false });
        const cl = await CompanyLocation.findOne({ locationIds: locationId }).lean();
        if (cl && (await this.hasCompanyToken(cl.companyId))) return this._mintLocationToken(cl.companyId, locationId);
      }
      throw error;
    }
  }

  /**
   * Central accessor. Location token if present (refreshing when close to expiry), else mint
   * one from the agency token. Never resurrects an uninstalled location.
   */
  async getAccessToken(locationId) {
    const token = await OAuthToken.findActiveToken(locationId);
    if (token) {
      if (token.needsRefresh()) return this.refreshAccessToken(locationId);
      return this.crypto.decrypt(token.accessToken);
    }

    const inst = await Installation.findOne({ locationId }).lean();
    if (inst?.status === 'uninstalled') {
      const err = new Error(`App is uninstalled for location: ${locationId}`);
      err.statusCode = 401;
      err.code = 'UNINSTALLED';
      throw err;
    }

    const cl = await CompanyLocation.findOne({ locationIds: locationId }).lean();
    if (cl && (await this.hasCompanyToken(cl.companyId))) {
      if (!this._minting.has(locationId)) {
        const p = this._mintLocationToken(cl.companyId, locationId)
          .then(async (t) => {
            await this._ensureInstallation(locationId, cl.companyId);
            return t;
          })
          .finally(() => this._minting.delete(locationId));
        this._minting.set(locationId, p);
      }
      return this._minting.get(locationId);
    }

    const err = new Error(`No installation for location: ${locationId}`);
    err.statusCode = 401;
    err.code = 'NOT_INSTALLED';
    throw err;
  }

  // ── Embedded UI sessions ─────────────────────────────────────

  decryptSsoPayload(encryptedPayload) {
    try {
      return this.crypto.decryptSsoPayload(encryptedPayload);
    } catch (error) {
      console.error(`[Auth] SSO decryption failed | ${formatError(error)}`);
      const err = new Error('Invalid or expired SSO session');
      err.statusCode = 401;
      throw err;
    }
  }

  /**
   * GHL user context → our session claims. A context with an activeLocation is a sub-account
   * view; one without (type 'agency') is the agency-level custom page.
   */
  claimsFromUserData(u) {
    const base = {
      userId: u.userId || '',
      companyId: u.companyId || '',
      name: u.userName || u.name || '',
      email: u.email || '',
      role: u.role || 'user',
      userType: u.type || '',
    };
    if (u.activeLocation) return { ...base, scope: 'location', locationId: u.activeLocation };
    if (u.companyId) return { ...base, scope: 'agency', locationId: null };
    const err = new Error('Open this app from an agency or sub-account.');
    err.statusCode = 401;
    throw err;
  }

  signSession(claims) {
    const ttl = Number(process.env.SESSION_TTL) || 43200;
    return jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: ttl });
  }

  verifySession(token) {
    return jwt.verify(token, process.env.JWT_SECRET);
  }
}

module.exports = AuthService;
