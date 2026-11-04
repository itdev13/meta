import { API_BASE, ApiError, api } from './api';

/** Share-to-connect links (CRM side, authed — sub-account or agency session). */
export const shareApi = (locationId) => {
  const base = `/api/locations/${encodeURIComponent(locationId)}/numbers/share`;
  return {
    /** body { numberId?, label?, expiresHours? } → { id, url, token, expiresAt, numberId, label, state, … } */
    create: (body = {}) => api.post(base, body),
    /** → [{ id, label, numberId, sessionId, state: 'pending'|'in_progress'|'connected', phoneNumber, createdBy, createdAt, expiresAt, usedAt }] */
    list: () => api.get(base),
    revoke: (id) => api.del(`${base}/${encodeURIComponent(id)}`),
  };
};

/** Absolute connect URL even when the backend has no FRONTEND_URL (it then returns a relative path). */
export function shareUrl(link) {
  if (!link?.url) return '';
  return /^https?:\/\//i.test(link.url) ? link.url : `${window.location.origin}${link.url}`;
}

async function publicRequest(method, path, body) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError('Can’t reach the server. Check your connection and try again.', 0, 'NETWORK');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok || data?.success === false) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.code);
  }
  return data?.data ?? data;
}

/** Public connect page (no CRM login; the token is the credential). */
export const publicConnect = (token) => {
  const base = `/public/connect/${encodeURIComponent(token)}`;
  return {
    /** → { businessName, label, status, method, qr, pairingCode, phoneNumber, waName, expiresAt, lastError } */
    get: () => publicRequest('GET', base),
    /** body { method: 'qr'|'code', phone? } */
    start: (body) => publicRequest('POST', `${base}/start`, body),
    cancel: () => publicRequest('POST', `${base}/cancel`, {}),
  };
};
