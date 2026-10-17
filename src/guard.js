// Safety limits for a public demo that is connected to a PayPal sandbox account.
//
// 1. Recipient allow-list: in live (sandbox) mode an invoice may only be created for an address
//    listed in SEND_ALLOWED_EMAILS (comma-separated; an entry starting with "@" allows a domain).
//    If the list is empty, creating invoices is refused (fail closed).
// 2. Daily cap on actions that write to PayPal (create, send, remind, record payment):
//    WRITE_DAILY_CAP per UTC day, counted in KV (CAP_KV) when bound, otherwise per isolate.
// Neither applies to the built-in sample data (mock), which never reaches PayPal.

const memory = new Map();
const bad = (m, status) => Object.assign(new Error(m), { status });

export function allowedRecipients(env) {
  return String(env.SEND_ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function checkRecipient(env, email) {
  const list = allowedRecipients(env);
  const e = String(email || '').trim().toLowerCase();
  if (!list.length) throw bad('This demo is not configured to create invoices at PayPal (no allowed recipients). Use the sample data instead.', 403);
  if (!e) throw bad(`On this demo an invoice must go to the sandbox test buyer: ${list.filter((x) => !x.startsWith('@')).join(', ') || list.join(', ')}`, 403);
  const ok = list.some((x) => (x.startsWith('@') ? e.endsWith(x) : e === x));
  if (!ok) throw bad(`On this demo invoices can only be sent to the sandbox test buyer (${list.join(', ')}), not to ${e}.`, 403);
}

export async function takeWrite(env, { now = () => new Date() } = {}) {
  const cap = Math.max(0, Number(env.WRITE_DAILY_CAP ?? 50) || 0);
  const key = `writes:${now().toISOString().slice(0, 10)}`;
  let n = 0;
  if (env.CAP_KV) {
    try { n = Number(await env.CAP_KV.get(key)) || 0; } catch { n = memory.get(key) || 0; }
  } else n = memory.get(key) || 0;
  if (n >= cap) throw bad(`The demo's daily limit of ${cap} PayPal actions is used up. Try again tomorrow (UTC), or use the sample data.`, 429);
  if (env.CAP_KV) {
    try { await env.CAP_KV.put(key, String(n + 1), { expirationTtl: 60 * 60 * 48 }); return; } catch { /* fall back */ }
  }
  memory.set(key, n + 1);
}

export function _resetGuard() { memory.clear(); }
