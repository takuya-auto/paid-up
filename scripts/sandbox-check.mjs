// Run the real PayPal sandbox calls this app depends on, one stage at a time, and print what
// came back (statuses and the fields we read - never credentials or tokens).
//
//   node scripts/sandbox-check.mjs create <buyer-email>   draft + send two invoices to the sandbox buyer
//   node scripts/sandbox-check.mjs status <id> [<id>...]  re-read invoices (after paying one as the buyer)
//   node scripts/sandbox-check.mjs remind <id>            send a reminder
//   node scripts/sandbox-check.mjs record <id> <amount>   record an external payment
//   node scripts/sandbox-check.mjs transactions [days]    Transaction Search for the last N days (max 31)
//
// Credentials come from .dev.vars (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, git-ignored).
// A private log with PayPal debug ids is appended to media/sandbox-check.log (git-ignored).

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createPayPal } from '../src/paypal/client.js';
import { toPayPalInvoice, summarize } from '../src/paypal/build.js';
import { incoming } from '../src/agent/reconcile.js';

function loadDevVars() {
  const env = {};
  let text = '';
  try { text = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8'); } catch { /* none */ }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return env;
}

const env = loadDevVars();
if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
  console.error('STOP: .dev.vars has no PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (this script never uses the mock).');
  process.exit(2);
}
const pp = createPayPal({ ...env, PAYPAL_ENV: 'sandbox' });
const today = new Date().toISOString().slice(0, 10);
const plus = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

function log(stage, data) {
  mkdirSync(new URL('../media/', import.meta.url), { recursive: true });
  appendFileSync(new URL('../media/sandbox-check.log', import.meta.url), `${new Date().toISOString()} ${stage} ${JSON.stringify({ data, calls: pp.calls })}\n`);
}

const show = (r) => ({ id: r.id, number: r.number, status: r.status, total: r.total, paid: r.paid, due: r.due, due_date: r.due_date, first_sent: r.first_sent, last_sent: r.last_sent, payer_url: r.payer_url ? 'present' : 'missing', payment_ids: r._payment_ids });

const [stage, ...args] = process.argv.slice(2);
try {
  if (stage === 'create') {
    const buyer = args[0];
    if (!/@/.test(buyer || '')) throw new Error('usage: create <sandbox buyer email>');
    const out = [];
    for (const [name, amount, due] of [['Sandbox check A (to be paid by the buyer)', 42, plus(14)], ['Sandbox check B (external payment)', 100, plus(-3)]]) {
      const raw = await pp.createDraft(toPayPalInvoice({ recipient: { name: 'Sandbox Buyer', email: buyer }, items: [{ name, quantity: 1, unit_amount: amount }], currency: 'USD', due_date: due, note: 'Paid-Up sandbox check' }));
      out.push({ created_keys: Object.keys(raw || {}), has_id: !!raw?.id, links: raw?.links?.map((l) => l.rel) });
      const id = raw.id || raw.href?.split('/').pop();
      const sent = await pp.send(id, { send_to_recipient: true, send_to_invoicer: true });
      out.push({ send_response_keys: Object.keys(sent || {}) });
      out.push(show(summarize(await pp.getInvoice(id), today)));
    }
    console.log(JSON.stringify(out, null, 1));
    log('create', out);
  } else if (stage === 'status') {
    const out = [];
    for (const id of args) out.push(show(summarize(await pp.getInvoice(id), today)));
    console.log(JSON.stringify(out, null, 1));
    log('status', out);
  } else if (stage === 'remind') {
    await pp.remind(args[0], { subject: 'Paid-Up sandbox reminder', note: 'Sandbox check of the reminder call.', send_to_recipient: true, send_to_invoicer: true });
    const r = show(summarize(await pp.getInvoice(args[0]), today));
    console.log(JSON.stringify(r, null, 1));
    log('remind', r);
  } else if (stage === 'record') {
    const inv = summarize(await pp.getInvoice(args[0]), today);
    await pp.recordPayment(args[0], { method: 'PAYPAL', payment_date: today, amount: { currency_code: inv.currency, value: Number(args[1] || inv.due).toFixed(2) }, note: 'Matched to PayPal transaction SANDBOX-CHECK' });
    const r = show(summarize(await pp.getInvoice(args[0]), today));
    console.log(JSON.stringify(r, null, 1));
    log('record', r);
  } else if (stage === 'transactions') {
    const days = Math.min(31, Number(args[0]) || 7);
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000);
    const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const raw = await pp.searchTransactions({ start: fmt(start), end: fmt(end) });
    const r = { total_items: raw.total_items, last_refreshed: raw.last_refreshed_datetime, incoming: incoming(raw).map((t) => ({ id: t.id, amount: t.amount, date: t.date, invoice_ref: t.invoice_ref, payer_has_email: !!t.email })) };
    console.log(JSON.stringify(r, null, 1));
    log('transactions', r);
  } else {
    console.log('stages: create <buyer-email> | status <id...> | remind <id> | record <id> <amount> | transactions [days]');
  }
} catch (e) {
  console.error('ERROR', e.message, e.paypal ? JSON.stringify(e.paypal).slice(0, 600) : '');
  log(`${stage}-error`, { message: e.message });
  process.exit(1);
}
