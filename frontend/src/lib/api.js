export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

let token = null;
let onExpired = null;

export function setToken(t) {
  token = t;
}
export function getToken() {
  return token;
}
export function onSessionExpired(fn) {
  onExpired = fn;
}

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
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
    if (res.status === 401 && data?.code === 'SESSION_EXPIRED' && onExpired) onExpired();
    throw new ApiError(data?.error || data?.message || `Request failed (${res.status})`, res.status, data?.code);
  }
  return data?.data ?? data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b = {}) => request('PUT', p, b),
  patch: (p, b = {}) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};

/** Location-scoped helpers (works for sub-account and agency sessions). */
export const loc = (locationId) => {
  const base = `/api/locations/${encodeURIComponent(locationId)}`;
  return {
    overview: () => api.get(`${base}/overview`),
    numbers: () => api.get(`${base}/numbers`),
    link: (body) => api.post(`${base}/numbers`, body),
    update: (id, body) => api.patch(`${base}/numbers/${id}`, body),
    relink: (id, body) => api.post(`${base}/numbers/${id}/relink`, body),
    resume: (id) => api.post(`${base}/numbers/${id}/resume`),
    pause: (id) => api.post(`${base}/numbers/${id}/pause`),
    cancel: (id) => api.post(`${base}/numbers/${id}/cancel`),
    unlink: (id) => api.del(`${base}/numbers/${id}`),
    test: (id, body) => api.post(`${base}/numbers/${id}/test`, body),
    activity: (q = {}) => api.get(`${base}/activity?${new URLSearchParams(q)}`),
    automations: () => api.get(`${base}/automations`),
    requestAccess: (message) => api.post(`${base}/access-request`, { message }),
    alerts: () => api.get(`${base}/alerts`),
    saveAlerts: (body) => api.put(`${base}/alerts`, body),
    testAlert: () => api.post(`${base}/alerts/test`),
  };
};

export const agency = {
  overview: (refresh) => api.get(`/api/agency/overview${refresh ? '?refresh=1' : ''}`),
  saveSettings: (body) => api.put('/api/agency/settings', body),
  setAccess: (locationId, body) => api.patch(`/api/agency/sub-accounts/${encodeURIComponent(locationId)}/access`, body),
  decline: (locationId) => api.post(`/api/agency/sub-accounts/${encodeURIComponent(locationId)}/decline`),
  bulkAccess: (locationIds, enabled) => api.post('/api/agency/sub-accounts/bulk-access', { locationIds, enabled }),
};

// ── Session bootstrap ─────────────────────────────────────────

function ghlUserContext(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMsg);
      reject(new Error('Open this app from inside your CRM (agency or sub-account menu).'));
    }, timeoutMs);
    function onMsg(event) {
      if (event.data?.message === 'REQUEST_USER_DATA_RESPONSE') {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(event.data.payload);
      }
    }
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*');
  });
}

/** → { token, user, context } */
export async function startSession() {
  const params = new URLSearchParams(window.location.search);
  const dev = params.get('dev');
  let data;
  if (dev && import.meta.env.VITE_ALLOW_DEV === 'true') {
    data = await api.post('/auth/dev', {
      scope: dev === 'agency' ? 'agency' : 'location',
      companyId: params.get('company') || 'dev_company',
      locationId: params.get('location') || 'dev_location',
    });
  } else {
    const payload = await ghlUserContext();
    data = await api.post('/auth/session', { payload });
  }
  setToken(data.token);
  return data;
}
