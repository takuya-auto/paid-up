// When did we last remind a client about an invoice?
// PayPal's invoice metadata.last_sent_time is NOT updated by the remind call (checked in the
// sandbox, 2026-10-17), so the quiet period needs our own record. Stored in KV (CAP_KV, key
// prefix "remind:") when bound, otherwise in memory per isolate.

const memory = new Map();

export function createHistory(env, { prefix = '' } = {}) {
  const kv = env.CAP_KV;
  const key = (id) => `remind:${prefix}${id}`;
  return {
    async lastReminder(id) {
      if (kv) { try { return (await kv.get(key(id))) || null; } catch { /* fall back */ } }
      return memory.get(key(id)) || null;
    },
    async recordReminder(id, isoTime) {
      if (kv) { try { await kv.put(key(id), isoTime, { expirationTtl: 60 * 60 * 24 * 120 }); return; } catch { /* fall back */ } }
      memory.set(key(id), isoTime);
    },
  };
}

/** Latest of PayPal's last_sent_time and our own reminder record. */
export function lastContact(row, reminderIso) {
  const a = row.last_sent || row.first_sent || '';
  const b = reminderIso || '';
  return a > b ? a : b;
}

export function _resetHistory() { memory.clear(); }
