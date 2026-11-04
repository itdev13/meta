const axios = require('axios');
const { TAG_PREFIX, TtlCache } = require('./routing');

/**
 * Number routing feature — which linked number an outbound message goes from. The routing
 * itself lives in MessagingService.pickRoute (core pipeline); this module serves the UI.
 *
 *   GET /api/locations/:locationId/routing/users → [{ id, name, email, role }]
 *   GET /api/locations/:locationId/routing       → { steps: [{ key, title, description, example }], tagPrefix }
 *
 * Both respond with the usual { success, data } envelope.
 */

const STEPS = [
  {
    key: 'explicit',
    title: 'Workflow picks a number',
    description: 'A workflow action with a “Send from” number always wins. Use the number’s #, its phone, or its id.',
    example: 'Send from: WA#2',
  },
  {
    key: 'override',
    title: 'Override in the message',
    description: 'Put {WA#n} anywhere in your message to send it from WhatsApp #n. The code is removed before the customer sees it.',
    example: '{WA#2}',
  },
  {
    key: 'tag',
    title: 'Contact tag',
    description: `Tag a contact with ${TAG_PREFIX} followed by one of your linked phone numbers, and every reply to them goes from that number.`,
    example: `${TAG_PREFIX} +15551234567`,
  },
  {
    key: 'assigned_user',
    title: 'Contact’s assigned user',
    description: 'If the contact is assigned to a team member, replies go from the number assigned to that person.',
    example: 'Contact → Assigned user → Number',
  },
  {
    key: 'sender',
    title: 'Who clicked send',
    description: 'Otherwise, the number assigned to the team member sending the message is used.',
    example: 'You → Your number',
  },
  {
    key: 'last_used',
    title: 'Same number as last time',
    description: 'Keeps the conversation on the number this contact last wrote to or heard from.',
    example: 'Last conversation',
  },
  {
    key: 'default',
    title: 'Default number',
    description: 'Falls back to your default number, then to whichever connected number was active most recently.',
    example: 'Default ★',
  },
];

function register({ app, guards, services }) {
  const ghl = services.ghlService;
  const usersCache = new TtlCache(5 * 60_000, 2000);

  async function listUsers(locationId) {
    const cached = usersCache.get(locationId);
    if (cached) return cached;
    try {
      const res = await ghl._apiRequest(locationId, (t) =>
        axios.get(`${ghl.apiBase}/users/`, { params: { locationId }, headers: ghl._headers(t, false) }),
      );
      const users = (res?.data?.users || [])
        .filter((u) => u && u.id && !u.deleted)
        .map((u) => ({
          id: String(u.id),
          name: u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Unnamed user',
          email: u.email || '',
          role: u.roles?.role || u.role || '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      usersCache.set(locationId, users);
      return users;
    } catch (err) {
      console.warn(`[routing] users for ${locationId} failed: ${err?.response?.status || ''} ${err.message}`);
      return [];
    }
  }

  const wrap = (fn) => async (req, res, next) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };

  app.get(
    '/api/locations/:locationId/routing/users',
    guards.requireSession,
    guards.resolveLocation('locationId'),
    wrap((req) => listUsers(req.locationId || req.params.locationId)),
  );

  app.get(
    '/api/locations/:locationId/routing',
    guards.requireSession,
    guards.resolveLocation('locationId'),
    wrap(() => ({ steps: STEPS, tagPrefix: TAG_PREFIX })),
  );
}

module.exports = { register, STEPS };
