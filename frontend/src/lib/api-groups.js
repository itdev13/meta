import { api } from './api';

/** WhatsApp groups API (feature: groups). Sub-account or agency session. */
export const groupsApi = (locationId) => {
  const base = `/api/locations/${encodeURIComponent(locationId)}/groups`;
  return {
    /** → { numbers: [{ numberId, phoneNumber, label, connected, syncGroups, groups: [...], error }] } */
    list: ({ numberId, refresh } = {}) => {
      const params = new URLSearchParams();
      if (numberId) params.set('numberId', numberId);
      if (refresh) params.set('refresh', '1');
      const qs = params.toString();
      return api.get(`${base}${qs ? `?${qs}` : ''}`);
    },
    /** Create / ensure the group's CRM contact now. → { jid, subject, contactId, created } */
    link: (groupJid, numberId) => api.post(`${base}/link`, { groupJid, ...(numberId ? { numberId } : {}) }),
  };
};
