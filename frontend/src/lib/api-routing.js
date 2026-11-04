import { api } from './api';

/** Number routing API (feature: routing). Sub-account or agency session. */
export const routingApi = (locationId) => {
  const base = `/api/locations/${encodeURIComponent(locationId)}/routing`;
  return {
    /** → [{ id, name, email, role }] — the sub-account's GHL users ([] if GHL is unreachable). */
    users: () => api.get(`${base}/users`),
    /** → { steps: [{ key, title, description, example }], tagPrefix: 'wa:' } in priority order. */
    explainer: () => api.get(base),
  };
};
