/**
 * Pipeline hook points that feature modules plug into, so features (consent, rules, groups,
 * analytics…) never have to edit the core pipeline files.
 *
 *   afterInbound(ctx)  — after a WhatsApp message was written to GHL. Runs in registration order,
 *                        awaited one by one; errors are logged, never thrown. A hook may set
 *                        ctx.handled = true to tell later hooks the message was consumed
 *                        (e.g. a STOP keyword handled by consent → rules skip it).
 *       ctx = { session:{id,locationId,companyId}, sessionDoc, msg, info:{kind,text,media},
 *               text, attachments, mapping, created, fromMe, isGroup, contactId, ghlMessageId,
 *               triggerPayload, handled }
 *
 *   beforeSend(ctx)    — before an outbound message is queued. Awaited in order; THROWING blocks
 *                        the send (use an Error with .code and .statusCode). A hook may rewrite
 *                        ctx.text (e.g. template variables).
 *       ctx = { locationId, contactId, phone, jid, text, attachments, source, session, mapping }
 *
 *   afterSend(ctx)     — after an outbound message went out. Errors logged, never thrown.
 *       ctx = { ...beforeSend ctx, waMessageIds }
 */
const registry = { afterInbound: [], beforeSend: [], afterSend: [] };

function register(point, name, fn) {
  if (!registry[point]) throw new Error(`Unknown hook point: ${point}`);
  registry[point].push({ name, fn });
}

async function runSafe(point, ctx) {
  for (const { name, fn } of registry[point]) {
    try {
      await fn(ctx);
    } catch (err) {
      console.warn(`[hook:${point}:${name}] ${err.message}`);
    }
  }
  return ctx;
}

/** beforeSend: errors propagate (a hook can block the send). */
async function runStrict(point, ctx) {
  for (const { fn } of registry[point]) await fn(ctx);
  return ctx;
}

module.exports = {
  register,
  afterInbound: (ctx) => runSafe('afterInbound', ctx),
  beforeSend: (ctx) => runStrict('beforeSend', ctx),
  afterSend: (ctx) => runSafe('afterSend', ctx),
};
