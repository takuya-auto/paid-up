// In-memory stand-in for the PayPal sandbox. Same response shapes as Invoicing v2 and
// Transaction Search v1 (only the fields this app reads). State lives per isolate and is
// seeded with fictional customers so the UI has something to show.

import { SEED_INVOICES, SEED_TRANSACTIONS } from '../../fixtures/seed.js';

let store = null;

function fresh() {
  return {
    seq: 1000,
    invoices: new Map(SEED_INVOICES.map((inv) => [inv.id, structuredClone(inv)])),
    transactions: structuredClone(SEED_TRANSACTIONS),
  };
}

export function resetMock() { store = fresh(); }

const nowIso = () => new Date().toISOString();
const notFound = (id) => Object.assign(new Error(`PayPal: invoice ${id} not found (mock)`), { status: 404 });

export function createMockPayPal() {
  if (!store) store = fresh();
  const calls = [];
  const log = (method, path, status = 200) => calls.push({ method, path, status, ms: 0, mock: true });

  function get(id) {
    const inv = store.invoices.get(id);
    if (!inv) throw notFound(id);
    return inv;
  }

  function totals(inv) {
    const total = (inv.items || []).reduce((s, it) => s + Number(it.quantity || 1) * Number(it.unit_amount.value), 0);
    const paid = (inv.payments?.transactions || []).reduce((s, t) => s + Number(t.amount?.value || 0), 0);
    const cur = inv.detail.currency_code;
    inv.amount = { currency_code: cur, value: total.toFixed(2) };
    inv.payments = { ...(inv.payments || {}), paid_amount: { currency_code: cur, value: paid.toFixed(2) }, transactions: inv.payments?.transactions || [] };
    inv.due_amount = { currency_code: cur, value: Math.max(0, total - paid).toFixed(2) };
    return inv;
  }

  return {
    mode: 'mock',
    environment: 'mock',
    calls,
    async createDraft(body) {
      const id = `INV2-MOCK-${(++store.seq).toString().padStart(4, '0')}`;
      const inv = totals({
        id,
        status: 'DRAFT',
        detail: { ...body.detail, invoice_number: String(store.seq), invoice_date: nowIso().slice(0, 10), metadata: { create_time: nowIso() } },
        invoicer: body.invoicer || {},
        primary_recipients: body.primary_recipients,
        items: body.items,
      });
      store.invoices.set(id, inv);
      log('POST', '/v2/invoicing/invoices', 201);
      return structuredClone(inv);
    },
    async getInvoice(id) {
      log('GET', `/v2/invoicing/invoices/${id}`);
      return structuredClone(get(id));
    },
    async listInvoices() {
      log('GET', '/v2/invoicing/invoices');
      const items = [...store.invoices.values()].map((i) => structuredClone(totals(i)));
      return { total_items: items.length, total_pages: 1, items };
    },
    async send(id) {
      const inv = get(id);
      if (inv.status !== 'DRAFT') throw Object.assign(new Error(`PayPal: invoice ${id} is ${inv.status}, only drafts can be sent (mock)`), { status: 502 });
      inv.status = 'SENT';
      inv.detail.metadata = { ...inv.detail.metadata, first_sent_time: nowIso(), last_sent_time: nowIso(), recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${id}` };
      log('POST', `/v2/invoicing/invoices/${id}/send`, 202);
      return { rel: 'self', href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${id}`, method: 'GET' };
    },
    async remind(id) {
      get(id); // like the sandbox (2026-10-17): remind does not change metadata.last_sent_time
      log('POST', `/v2/invoicing/invoices/${id}/remind`, 204);
      return null;
    },
    async recordPayment(id, detail) {
      const inv = get(id);
      const txId = `EXTR-MOCK-${(++store.seq)}`;
      inv.payments = inv.payments || { transactions: [] };
      inv.payments.transactions = [...(inv.payments.transactions || []), { payment_id: txId, method: detail.method, payment_date: detail.payment_date, amount: detail.amount, note: detail.note }];
      totals(inv);
      inv.status = Number(inv.due_amount.value) <= 0 ? 'MARKED_AS_PAID' : 'PARTIALLY_PAID';
      log('POST', `/v2/invoicing/invoices/${id}/payments`, 200);
      return { payment_id: txId };
    },
    async searchTransactions() {
      log('GET', '/v1/reporting/transactions');
      return { transaction_details: structuredClone(store.transactions), total_items: store.transactions.length };
    },
  };
}
