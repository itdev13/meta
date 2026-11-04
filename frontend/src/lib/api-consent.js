import { API_BASE, ApiError, api, getToken } from './api';

/** Consent & compliance API (sub-account or agency session). */
export const consentApi = (locationId) => {
  const base = `/api/locations/${encodeURIComponent(locationId)}/consent`;
  return {
    settings: () => api.get(`${base}/settings`),
    saveSettings: (body) => api.put(`${base}/settings`, body),
    stats: () => api.get(`${base}/stats`),
    contacts: (q = {}) => {
      const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      return api.get(`${base}/contacts?${params}`);
    },
    log: (id) => api.get(`${base}/contacts/${encodeURIComponent(id)}/log`),
    manual: (body) => api.post(`${base}/manual`, body),

    /** The full consent log as CSV text (fetched, because downloads are blocked in the CRM iframe). */
    exportCsv: async () => {
      let res;
      try {
        res = await fetch(`${API_BASE}${base}/export.csv`, { headers: { Authorization: `Bearer ${getToken()}` } });
      } catch {
        throw new ApiError('Can’t reach the server. Check your connection and try again.', 0, 'NETWORK');
      }
      if (!res.ok) {
        let msg = `Export failed (${res.status})`;
        try {
          const j = await res.json();
          msg = j.error || j.message || msg;
        } catch {
          /* not JSON */
        }
        throw new ApiError(msg, res.status);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'whatsapp-consent-log.csv';
      return { text: await res.text(), filename: name };
    },
  };
};
