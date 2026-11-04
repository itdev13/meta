const WaSession = require('../schemas/wa-session.schema');

/**
 * Per-number outbound pacing — the main defence against WhatsApp flagging a linked number.
 *
 *   • strictly serial per number (no parallel bursts)
 *   • a minimum gap between sends with ±20% random jitter
 *   • optional "typing…" presence before text, scaled to message length
 *   • a hard daily cap per number (atomic counter, resets at UTC midnight)
 *
 * Limits come from the number's own settings, else the agency default, else env defaults.
 */
class SendQueue {
  constructor(sessionManager) {
    this.manager = sessionManager;
    this.chains = new Map(); // sessionId → tail promise
    this.lastSentAt = new Map(); // sessionId → ms
  }

  static today() {
    return new Date().toISOString().slice(0, 10);
  }

  async _reserveDailySlot(sessionId, dailyLimit) {
    const today = SendQueue.today();
    const doc = await WaSession.findOneAndUpdate(
      { _id: sessionId, $or: [{ 'stats.sentDate': { $ne: today } }, { 'stats.sentToday': { $lt: dailyLimit } }] },
      [
        {
          $set: {
            'stats.sentToday': { $cond: [{ $eq: ['$stats.sentDate', today] }, { $add: [{ $ifNull: ['$stats.sentToday', 0] }, 1] }, 1] },
            'stats.sentDate': today,
            'stats.totalOutbound': { $add: [{ $ifNull: ['$stats.totalOutbound', 0] }, 1] },
            lastMessageAt: '$$NOW',
          },
        },
      ],
      { new: true },
    ).lean();
    if (!doc) {
      const err = new Error(`Daily sending limit (${dailyLimit}) reached for this number. It resets at 00:00 UTC.`);
      err.code = 'DAILY_LIMIT';
      err.statusCode = 429;
      throw err;
    }
  }

  /**
   * Queue one send. `content` is a Baileys message content object. Resolves with the sent
   * WAMessage once it actually went out (after waiting its turn).
   */
  enqueue(session, jid, content, pace) {
    const id = String(session._id || session.id);
    const minDelay = session.settings?.minDelayMs ?? pace.minDelayMs;
    const dailyLimit = session.settings?.dailyLimit ?? pace.dailyLimit;
    const typing = session.settings?.typingSimulation !== false && !!content.text;

    const run = async () => {
      this.manager.getSocket(id); // fail fast if offline
      const since = Date.now() - (this.lastSentAt.get(id) || 0);
      const gap = Math.round(minDelay * (0.8 + Math.random() * 0.4));
      if (since < gap) await new Promise((r) => setTimeout(r, gap - since));
      await this._reserveDailySlot(id, dailyLimit);
      if (typing) await this.manager.typing(id, jid, Math.min(3500, 400 + content.text.length * 35));
      const sent = await this.manager.sendRaw(id, jid, content);
      this.lastSentAt.set(id, Date.now());
      return sent;
    };

    const tail = this.chains.get(id) || Promise.resolve();
    const next = tail.catch(() => {}).then(run);
    this.chains.set(
      id,
      next.catch(() => {}).finally(() => {
        if (this.chains.get(id) === next) this.chains.delete(id);
      }),
    );
    return next;
  }

  pending(sessionId) {
    return this.chains.has(String(sessionId));
  }
}

module.exports = SendQueue;
