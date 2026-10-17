// PayPal REST client (sandbox by default) with an in-memory mock for development.
//
// Live mode needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (Worker secrets / .dev.vars).
// Without them the mock is used, which returns the same shapes as Invoicing v2 and
// Transaction Search v1 so the rest of the app does not care which one it talks to.
//
// STATUS: the live paths below follow PayPal's published OpenAPI schema but have not yet
// been exercised against the sandbox. Each call is marked in docs/sandbox-check.md once it
// has been verified with real credentials.

import { createMockPayPal } from './mock.js';

const BASES = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

let tokenCache = null; // { key, token, expiresAt } (per isolate)

export function createPayPal(env, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return createMockPayPal(env);
  const envName = (env.PAYPAL_ENV || 'sandbox').toLowerCase();
  if (envName !== 'sandbox') throw new Error('Only the PayPal sandbox is supported in this project');
  const base = BASES.sandbox;
  const calls = [];

  async function token() {
    const key = env.PAYPAL_CLIENT_ID;
    if (tokenCache && tokenCache.key === key && tokenCache.expiresAt - 60_000 > now()) return tokenCache.token;
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw Object.assign(new Error(`PayPal auth failed (${res.status})`), { status: 502 });
    const j = await res.json();
    tokenCache = { key, token: j.access_token, expiresAt: now() + (Number(j.expires_in) || 3000) * 1000 };
    return tokenCache.token;
  }

  async function call(method, path, body, { prefer } = {}) {
    const started = now();
    const headers = { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' };
    if (prefer) headers.prefer = prefer;
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    calls.push({ method, path, status: res.status, ms: now() - started, debug_id: res.headers.get('paypal-debug-id') });
    if (!res.ok) {
      const detail = data?.details?.[0]?.description || data?.message || data?.name || `HTTP ${res.status}`;
      throw Object.assign(new Error(`PayPal ${method} ${path.split('?')[0]}: ${detail}`), { status: res.status === 404 ? 404 : 502, paypal: data });
    }
    return data;
  }

  return {
    mode: 'live',
    environment: envName,
    calls,
    createDraft: (invoice) => call('POST', '/v2/invoicing/invoices', invoice, { prefer: 'return=representation' }),
    getInvoice: (id) => call('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`),
    listInvoices: ({ page = 1, pageSize = 50 } = {}) =>
      call('GET', `/v2/invoicing/invoices?page=${page}&page_size=${pageSize}&total_required=true`),
    send: (id, notification) => call('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, notification || {}),
    remind: (id, notification) => call('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, notification || {}),
    recordPayment: (id, detail) => call('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, detail),
    searchTransactions: ({ start, end }) =>
      call('GET', `/v1/reporting/transactions?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&fields=transaction_info,payer_info&page_size=100`),
  };
}

export function _resetTokenCache() { tokenCache = null; }
