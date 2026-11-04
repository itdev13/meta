import { api } from './api';

/** Per-number proxy (country-pinned residential proxies). Sub-account or agency session. */
export const proxyApi = (locationId) => {
  const base = `/api/locations/${encodeURIComponent(locationId)}/proxy`;
  return {
    /** → { enabled, countries: [{ code, name, count }] } */
    countries: () => api.get(`${base}/countries`),
    /** Restart the number's socket so a newly saved proxy takes effect. */
    apply: (numberId) => api.post(`${base}/apply/${encodeURIComponent(numberId)}`),
  };
};
