const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const WaAuthKey = require('../schemas/wa-auth-key.schema');

/**
 * Baileys auth state persisted in Mongo (one encrypted row per key). Drop-in replacement for
 * useMultiFileAuthState — survives redeploys and lets a session move between instances.
 */
async function useMongoAuthState(sessionId, crypto) {
  const sid = String(sessionId);

  const read = async (key) => {
    const doc = await WaAuthKey.findOne({ sessionId: sid, key }).lean();
    if (!doc) return null;
    try {
      return JSON.parse(crypto.decrypt(doc.value), BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const write = (key, data) => ({
    updateOne: {
      filter: { sessionId: sid, key },
      update: { $set: { sessionId: sid, key, value: crypto.encrypt(JSON.stringify(data, BufferJSON.replacer)) } },
      upsert: true,
    },
  });

  const creds = (await read('creds')) || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const out = {};
        if (!ids.length) return out;
        const docs = await WaAuthKey.find({ sessionId: sid, key: { $in: ids.map((id) => `${type}-${id}`) } }).lean();
        const byKey = new Map(docs.map((d) => [d.key, d.value]));
        for (const id of ids) {
          const raw = byKey.get(`${type}-${id}`);
          if (!raw) continue;
          try {
            let value = JSON.parse(crypto.decrypt(raw), BufferJSON.reviver);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            out[id] = value;
          } catch {
            /* corrupt key → treat as missing */
          }
        }
        return out;
      },
      set: async (data) => {
        const ops = [];
        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category])) {
            const value = data[category][id];
            const key = `${category}-${id}`;
            if (value) ops.push(write(key, value));
            else ops.push({ deleteOne: { filter: { sessionId: sid, key } } });
          }
        }
        if (ops.length) await WaAuthKey.bulkWrite(ops, { ordered: false });
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      await WaAuthKey.bulkWrite([write('creds', state.creds)]);
    },
    clear: async () => {
      await WaAuthKey.deleteMany({ sessionId: sid });
    },
  };
}

async function clearAuthState(sessionId) {
  await WaAuthKey.deleteMany({ sessionId: String(sessionId) });
}

module.exports = { useMongoAuthState, clearAuthState };
