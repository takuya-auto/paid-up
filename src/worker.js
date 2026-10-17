// Cloudflare Worker entry: serves the static UI (ASSETS binding) and /api/*.
// Endpoints that change something at PayPal are separate POSTs that the UI calls on a user's
// click; drafting, reminder wording and payment matching only propose.

import { createPayPal } from './paypal/client.js';
import { toPayPalInvoice, summarize, validateDraft, PAYMENT_METHODS, toAmount } from './paypal/build.js';
import { createLLM } from './llm/workersai.js';
import { extractDraft } from './agent/extract.js';
import { nextAction, draftReminder, TONES } from './agent/collect.js';
import { incoming, reconcile } from './agent/reconcile.js';
import { createHistory, lastContact } from './agent/history.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const todayUtc = () => new Date().toISOString().slice(0, 10);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
        return json({ error: err.message || 'Internal error', status }, status);
      }
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

async function body(request) {
  try { return await request.json(); } catch { throw bad('Invalid JSON body'); }
}

function dateParam(v) {
  const d = v ? String(v).slice(0, 10) : todayUtc();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('today must be YYYY-MM-DD');
  return d;
}

async function withContact(row, history) {
  row.last_reminder = await history.lastReminder(row.id);
  row.last_contact = lastContact(row, row.last_reminder);
  return row;
}

async function overview(pp, today, history) {
  const list = await pp.listInvoices({ pageSize: 100 });
  const rows = await Promise.all((list.items || []).map((inv) => withContact(summarize(inv, today), history)));
  const end = new Date(`${today}T23:59:59Z`);
  const start = new Date(end.getTime() - 30 * 86400000); // Transaction Search allows up to 31 days per call
  let txs = [];
  let txError = null;
  let txRefreshed = null;
  try {
    const raw = await pp.searchTransactions({ start: start.toISOString().replace(/\.\d{3}Z$/, 'Z'), end: end.toISOString().replace(/\.\d{3}Z$/, 'Z') });
    txRefreshed = raw?.last_refreshed_datetime || null; // Transaction Search data lags behind real time
    txs = incoming(raw);
  } catch (e) { txError = e.message; }
  const { matches, unmatched } = reconcile(rows, txs);
  const byInvoice = new Map(matches.map((m) => [m.invoice_id, m]));
  for (const r of rows) {
    r.match = byInvoice.get(r.id) || null;
    r.next = nextAction(r, today, r.match);
    delete r._payment_ids;
  }
  rows.sort((a, b) => b.next.priority - a.next.priority || b.days_overdue - a.days_overdue);
  const sum = (pred, f = 'due') => rows.filter(pred).reduce((s, r) => s + Number(r[f]), 0).toFixed(2);
  const open = (r) => r.next.action !== 'none' && r.status !== 'DRAFT';
  return {
    today,
    rows,
    unmatched_payments: unmatched,
    totals: {
      outstanding: sum(open),
      overdue: sum((r) => open(r) && r.days_overdue > 0),
      due_next_14_days: sum((r) => open(r) && r.due_date && r.days_overdue === 0 && r.due_date <= new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86400000).toISOString().slice(0, 10)),
      waiting_to_record: matches.reduce((s, m) => s + Number(m.amount), 0).toFixed(2),
      currency: rows[0]?.currency || 'USD',
    },
    transaction_search_error: txError,
    transactions_refreshed_at: txRefreshed,
  };
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const m = path.match(/^\/api\/invoices\/([A-Za-z0-9-]+)(?:\/(send|remind|reminder-draft|payments))?$/);
  const pp = () => createPayPal(env);
  const withCalls = (client, data) => ({ ...data, paypal_calls: client.calls, paypal_mode: client.mode });

  if (path === '/api/health' && request.method === 'GET') {
    const client = pp();
    return json({ ok: true, paypal: { mode: client.mode, environment: client.environment }, llm: await createLLM(env).status(), tones: TONES });
  }

  // 1. Read a messy request into an invoice draft (nothing is sent to PayPal).
  if (path === '/api/draft' && request.method === 'POST') {
    const b = await body(request);
    const llm = createLLM(env);
    const out = await extractDraft(b.text, { llm, today: dateParam(b.today) });
    return json({ ...out, llm: await llm.status() });
  }

  // 2. Create the draft invoice at PayPal (still not sent to the client).
  if (path === '/api/invoices' && request.method === 'POST') {
    const b = await body(request);
    const draft = validateDraft(b.draft);
    const client = pp();
    const inv = await client.createDraft(toPayPalInvoice(draft, { invoicerEmail: env.PAYPAL_INVOICER_EMAIL || undefined }));
    return json(withCalls(client, { invoice: summarize(inv, dateParam(b.today)) }), 201);
  }

  // 3. The overview: every invoice with its next action, plus payment matches.
  if (path === '/api/overview' && request.method === 'GET') {
    const client = pp();
    return json(withCalls(client, await overview(client, dateParam(url.searchParams.get('today')), createHistory(env))));
  }

  if (m) {
    const [, id, verb] = m;
    const client = pp();
    if (!verb && request.method === 'GET') {
      return json(withCalls(client, { invoice: summarize(await client.getInvoice(id), dateParam(url.searchParams.get('today'))) }));
    }
    if (verb === 'send' && request.method === 'POST') {
      const b = await body(request);
      await client.send(id, { send_to_recipient: true, send_to_invoicer: true, subject: b.subject || undefined, note: b.note || undefined });
      return json(withCalls(client, { invoice: summarize(await client.getInvoice(id), dateParam(b.today)) }));
    }
    if (verb === 'reminder-draft' && request.method === 'POST') {
      const b = await body(request);
      const today = dateParam(b.today);
      const row = await withContact(summarize(await client.getInvoice(id), today), createHistory(env));
      const llm = createLLM(env);
      return json(withCalls(client, { invoice_id: id, reminder: await draftReminder(row, { tone: b.tone, llm, today }), next: nextAction(row, today) }));
    }
    if (verb === 'remind' && request.method === 'POST') {
      const b = await body(request);
      if (!b.subject || !b.note) throw bad('subject and note are required (draft one with /reminder-draft first)');
      await client.remind(id, { subject: String(b.subject).slice(0, 4000), note: String(b.note).slice(0, 4000), send_to_invoicer: true, send_to_recipient: true });
      const history = createHistory(env);
      await history.recordReminder(id, new Date().toISOString());
      return json(withCalls(client, { invoice: await withContact(summarize(await client.getInvoice(id), dateParam(b.today)), history) }));
    }
    if (verb === 'payments' && request.method === 'POST') {
      const b = await body(request);
      const method = String(b.method || 'PAYPAL').toUpperCase();
      if (!PAYMENT_METHODS.includes(method)) throw bad(`method must be one of ${PAYMENT_METHODS.join(', ')}`);
      const inv = summarize(await client.getInvoice(id), dateParam(b.today));
      const amount = toAmount(b.amount ?? inv.due, inv.currency);
      if (Number(amount) <= 0 || Number(amount) > Number(inv.due)) throw bad(`amount must be between 0 and the balance due (${inv.due})`);
      await client.recordPayment(id, {
        method,
        payment_date: dateParam(b.payment_date || b.today),
        amount: { currency_code: inv.currency, value: amount },
        note: b.note ? String(b.note).slice(0, 2000) : (b.tx_id ? `Matched to PayPal transaction ${b.tx_id}` : undefined),
      });
      return json(withCalls(client, { invoice: summarize(await client.getInvoice(id), dateParam(b.today)) }));
    }
  }

  if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
  return json({ error: 'Not found' }, 404);
}
