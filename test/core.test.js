import test from 'node:test';
import assert from 'node:assert/strict';
import { toPayPalInvoice, validateDraft, summarize } from '../src/paypal/build.js';
import { ruleExtract, verify, extractDraft } from '../src/agent/extract.js';
import { nextAction, toneFor, draftReminder, templateReminder } from '../src/agent/collect.js';
import { incoming, reconcile, scorePair } from '../src/agent/reconcile.js';
import { createMockPayPal, resetMock } from '../src/paypal/mock.js';
import worker from '../src/worker.js';

const TODAY = '2026-11-01';

test('draft -> PayPal invoice body uses Invoicing v2 field names', () => {
  const body = toPayPalInvoice({
    recipient: { name: 'Maya Chen', business: 'Chen Bakery', email: 'maya@chen.example.com' },
    items: [{ name: 'Logo', quantity: 2, unit_amount: 150 }],
    currency: 'usd', due_date: '2026-11-30', note: 'Thanks',
  });
  assert.equal(body.detail.currency_code, 'USD');
  assert.deepEqual(body.detail.payment_term, { due_date: '2026-11-30' });
  assert.equal(body.items[0].unit_amount.value, '150.00');
  assert.equal(body.items[0].quantity, '2');
  assert.equal(body.primary_recipients[0].billing_info.email_address, 'maya@chen.example.com');
  assert.equal(body.primary_recipients[0].billing_info.name.surname, 'Chen');
});

test('validateDraft rejects drafts that must not reach PayPal', () => {
  assert.throws(() => validateDraft({ items: [] }), /line item/);
  assert.throws(() => validateDraft({ items: [{ name: 'x', unit_amount: 0 }] }), /no price/);
  assert.throws(() => validateDraft({ recipient: { email: 'not-an-email' }, items: [{ name: 'x', unit_amount: 5 }] }), /email/);
  assert.throws(() => validateDraft({ items: [{ name: 'x', unit_amount: -5 }] }), /Invalid amount/);
  assert.equal(validateDraft({ items: [{ name: 'x', unit_amount: 5 }] }).term, 'NET_15');
});

test('rule reader finds email, amounts, quantity and date', () => {
  const text = `Hi Alex,\nCan you send the invoice for the October work?\n- Website copy: 5 pages x $120 each\n- Rush fee $50\nPlease make it due 2026-11-20.\nThanks,\nTom Okafor\ntom@okafor-plumbing.example.com`;
  const d = ruleExtract(text, TODAY);
  assert.equal(d.recipient.email, 'tom@okafor-plumbing.example.com');
  assert.equal(d.recipient.name, 'Tom Okafor');
  assert.equal(d.items.length, 2);
  assert.deepEqual([d.items[0].quantity, d.items[0].unit_amount], [5, 120]);
  assert.equal(d.items[1].unit_amount, 50);
  assert.equal(d.due_date, '2026-11-20');
  const checks = verify(d, text);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));
});

test('verify flags values the model made up', () => {
  const text = 'Please invoice me for the logo, $300. - Ana';
  const checks = verify({ recipient: { name: 'Ana', email: 'ana@made-up.example.com' }, items: [{ name: 'Logo', quantity: 1, unit_amount: 450 }], evidence: { recipient: 'Ana', items: ['the logo, $300'] } }, text);
  assert.equal(checks.find((c) => c.field === 'recipient.email').ok, false);
  assert.equal(checks.find((c) => c.field === 'items[0]').ok, false); // 450 is not in the text
});

test('extractDraft falls back to rules when the LLM is unavailable', async () => {
  const llm = { available: async () => false, lastReason: 'daily cap 60 reached' };
  const out = await extractDraft('Logo design $300\nana@studio.example.com', { llm, today: TODAY });
  assert.equal(out.via, 'rules');
  assert.equal(out.draft.items[0].unit_amount, 300);
  assert.match(out.trace[0].note, /cap/);
});

test('extractDraft uses the LLM JSON when it is valid', async () => {
  const llm = {
    available: async () => true,
    chat: async () => ({ text: '```json\n{"recipient":{"name":"Ana","email":"ana@studio.example.com"},"items":[{"name":"Logo","quantity":1,"unit_amount":300}],"currency":"USD","due_date":null,"note":"Thanks!","evidence":{"recipient":"Ana","items":["Logo design $300"]}}\n```' }),
  };
  const out = await extractDraft('Logo design $300 - Ana, ana@studio.example.com', { llm, today: TODAY });
  assert.equal(out.via, 'llm');
  assert.equal(out.draft.recipient.email, 'ana@studio.example.com');
  assert.ok(out.checks.find((c) => c.field === 'items[0]').ok);
});

const row = (over = {}) => ({
  id: 'X', number: '7', status: 'SENT', recipient: { name: 'Tom', business: 'Okafor Plumbing', email: 'tom@okafor.example.com' },
  currency: 'USD', total: '600.00', paid: '0.00', due: '600.00', due_date: '2026-10-20', days_overdue: 12,
  first_sent: '2026-10-05T00:00:00Z', last_sent: '2026-10-05T00:00:00Z', items: [{ name: 'Website copy' }], ...over,
});

test('nextAction escalates tone and respects the quiet period', () => {
  assert.equal(toneFor(3), 'friendly');
  assert.equal(toneFor(12), 'firm');
  assert.equal(toneFor(30), 'final');
  assert.deepEqual([nextAction(row(), TODAY).action, nextAction(row(), TODAY).tone], ['remind', 'firm']);
  assert.equal(nextAction(row({ last_sent: '2026-10-30T00:00:00Z' }), TODAY).action, 'wait');
  assert.equal(nextAction(row({ status: 'PAID' }), TODAY).action, 'none');
  assert.equal(nextAction(row({ status: 'DRAFT' }), TODAY).action, 'send');
  assert.equal(nextAction(row({ due_date: '2026-11-02', days_overdue: 0 }), TODAY).tone, 'friendly');
  assert.equal(nextAction(row({ due_date: '2026-11-20', days_overdue: 0 }), TODAY).action, 'wait');
  assert.equal(nextAction(row(), TODAY, { currency: 'USD', amount: '600.00', payer: 'x', date: TODAY, reasons: ['a'] }).action, 'record_payment');
});

test('reminder text never carries links or threats, even if the model writes them', async () => {
  const llm = { available: async () => true, chat: async () => ({ text: '{"subject":"Pay now","note":"Please pay at https://evil.example.com today. Otherwise we will take legal action. Thanks Tom."}' }) };
  const r = await draftReminder(row(), { tone: 'final', llm, today: TODAY });
  assert.doesNotMatch(r.note, /https?:|legal action/i);
  const t = templateReminder({ tone: 'firm', client: 'Tom', invoice_number: '7', work: 'Website copy', amount_due: 'USD 600.00', due_date: '2026-10-20', days_overdue: 12 });
  assert.match(t.subject, /12 days overdue/);
});

test('reconcile matches a direct transfer to the right invoice with reasons', () => {
  const txs = incoming({ transaction_details: [
    { transaction_info: { transaction_id: 'T1', transaction_status: 'S', transaction_amount: { currency_code: 'USD', value: '600.00' }, transaction_initiation_date: '2026-10-30T10:00:00Z', transaction_note: 'website copy' }, payer_info: { email_address: 'accounts@okafor.example.com', payer_name: { alternate_full_name: 'Okafor Plumbing LLC' } } },
    { transaction_info: { transaction_id: 'T2', transaction_status: 'S', transaction_amount: { currency_code: 'USD', value: '75.00' } }, payer_info: { email_address: 'friend@example.com' } },
    { transaction_info: { transaction_id: 'T3', transaction_status: 'S', transaction_amount: { currency_code: 'USD', value: '-20.00' } } },
  ] });
  assert.equal(txs.length, 2); // outgoing money is ignored
  const other = row({ id: 'Y', number: '8', recipient: { name: 'Lena', business: 'Studio Vogel', email: 'lena@vogel.example.com' }, items: [{ name: 'Photos' }] });
  const { matches, unmatched } = reconcile([row(), other], txs);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].invoice_id, 'X');
  assert.ok(matches[0].reasons.some((r) => /domain/.test(r)));
  assert.deepEqual(unmatched.map((t) => t.id), ['T2']);
  assert.equal(scorePair(txs[0], row({ currency: 'EUR' })).score, 0);
});

test('reconcile does not propose a transaction already recorded on the invoice', () => {
  const txs = [{ id: 'T1', status: 'S', amount: '600.00', currency: 'USD', payer: 'Okafor Plumbing', email: 'a@okafor.example.com', note: '', date: TODAY }];
  assert.equal(reconcile([row({ _payment_ids: ['T1'] })], txs).matches.length, 0);
});

test('mock PayPal: create, send, remind, record payment change status like the API', async () => {
  resetMock();
  const pp = createMockPayPal();
  const inv = await pp.createDraft(toPayPalInvoice({ recipient: { email: 'a@b.example.com' }, items: [{ name: 'Work', unit_amount: 100 }] }));
  assert.equal(inv.status, 'DRAFT');
  await pp.send(inv.id);
  assert.equal((await pp.getInvoice(inv.id)).status, 'SENT');
  await pp.recordPayment(inv.id, { method: 'PAYPAL', payment_date: TODAY, amount: { currency_code: 'USD', value: '40.00' } });
  const after = summarize(await pp.getInvoice(inv.id), TODAY);
  assert.deepEqual([after.status, after.paid, after.due], ['PARTIALLY_PAID', '40.00', '60.00']);
  await assert.rejects(pp.send(inv.id), /only drafts/);
});

async function call(method, path, payload) {
  const res = await worker.fetch(new Request(`http://x${path}`, { method, headers: { 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined }), {});
  return { status: res.status, body: await res.json() };
}

test('API end to end on the mock: draft -> invoice -> send -> overview -> match -> record', async () => {
  resetMock();
  const health = await call('GET', '/api/health');
  assert.equal(health.body.paypal.mode, 'mock');
  const d = await call('POST', '/api/draft', { text: 'Brand refresh $900\njo@example.com\nDue 2026-11-15', today: TODAY });
  assert.equal(d.status, 200);
  assert.equal(d.body.via, 'rules'); // no AI binding in tests
  const created = await call('POST', '/api/invoices', { draft: d.body.draft, today: TODAY });
  assert.equal(created.status, 201);
  const id = created.body.invoice.id;
  const sent = await call('POST', `/api/invoices/${id}/send`, { today: TODAY });
  assert.equal(sent.body.invoice.status, 'SENT');
  const ov = await call('GET', `/api/overview?today=${TODAY}`);
  assert.equal(ov.status, 200);
  const okafor = ov.body.rows.find((r) => r.recipient.business === 'Okafor Plumbing');
  assert.equal(okafor.next.action, 'record_payment');
  assert.equal(ov.body.rows[0].id, okafor.id); // highest priority first
  const rec = await call('POST', `/api/invoices/${okafor.id}/payments`, { method: 'PAYPAL', tx_id: okafor.match.tx_id, today: TODAY });
  assert.equal(rec.body.invoice.status, 'MARKED_AS_PAID');
  const ov2 = await call('GET', `/api/overview?today=${TODAY}`);
  assert.equal(ov2.body.rows.find((r) => r.id === okafor.id).next.action, 'none');
  assert.ok(!ov2.body.rows.some((r) => r.match?.tx_id === okafor.match.tx_id)); // not proposed twice
  const tooMuch = await call('POST', `/api/invoices/${id}/payments`, { amount: 5000, today: TODAY });
  assert.equal(tooMuch.status, 400);
  const draftR = await call('POST', `/api/invoices/${id}/reminder-draft`, { tone: 'friendly', today: TODAY });
  assert.equal(draftR.body.reminder.via, 'template');
  const noText = await call('POST', `/api/invoices/${id}/remind`, { today: TODAY });
  assert.equal(noText.status, 400);
});

test('live client: one OAuth token is reused, calls carry Bearer and PayPal-Debug-Id is logged', async () => {
  const { createPayPal, _resetTokenCache } = await import('../src/paypal/client.js');
  _resetTokenCache();
  const seen = [];
  const fetchImpl = async (u, init) => {
    seen.push({ u, auth: init.headers.authorization, prefer: init.headers.prefer });
    if (u.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    if (u.includes('/missing')) return new Response(JSON.stringify({ name: 'RESOURCE_NOT_FOUND', details: [{ description: 'Invoice not found' }] }), { status: 404, headers: { 'paypal-debug-id': 'dbg1' } });
    return new Response(JSON.stringify({ id: 'INV2-1', status: 'DRAFT' }), { status: 201, headers: { 'paypal-debug-id': 'dbg2' } });
  };
  const pp = createPayPal({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }, { fetchImpl });
  assert.equal(pp.mode, 'live');
  await pp.createDraft({ detail: {} });
  await assert.rejects(pp.getInvoice('missing'), /Invoice not found/);
  assert.equal(seen.filter((s) => s.u.endsWith('/oauth2/token')).length, 1);
  assert.match(seen[0].u, /^https:\/\/api-m\.sandbox\.paypal\.com\//);
  assert.equal(seen[1].auth, 'Bearer tok');
  assert.equal(seen[1].prefer, 'return=representation');
  assert.deepEqual(pp.calls.map((c) => [c.status, c.debug_id]), [[201, 'dbg2'], [404, 'dbg1']]);
  assert.throws(() => createPayPal({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_ENV: 'live' }), /sandbox/);
});

test('a rule-based read is never shown as checked (discount + rush fee example)', async () => {
  const text = "Hello! The pitch deck redesign (12 slides at $40/slide) came out great. As agreed there's a $100 rush fee, and you offered 10% off the slides since we're a returning client. Invoice to Oak Street Ventures, Chris Wu, chris.wu@oakstreet.example.com. Due Nov 15.";
  const out = await extractDraft(text, { llm: null, today: TODAY });
  assert.equal(out.via, 'rules');
  assert.equal(out.checks[0].field, 'reader');
  assert.equal(out.checks[0].ok, false);
  assert.match(out.checks[0].reason, /10%/);
  assert.match(out.checks[0].reason, /rush fee/);
  assert.ok(out.checks.filter((c) => c.field.startsWith('items[')).every((c) => !c.ok));
});

test('zero-decimal currencies are sent without decimals (sandbox accounts are in JP)', () => {
  const body = toPayPalInvoice({ currency: 'JPY', items: [{ name: 'Logo', quantity: 1, unit_amount: 15000 }] });
  assert.equal(body.items[0].unit_amount.value, '15000');
  assert.throws(() => toPayPalInvoice({ currency: 'JPY', items: [{ name: 'Logo', unit_amount: 99.5 }] }), /decimals/);
  assert.equal(toPayPalInvoice({ items: [{ name: 'Logo', unit_amount: 99.5 }] }).items[0].unit_amount.value, '99.50');
});

test('quiet period uses our own reminder record (PayPal does not update last_sent on remind)', async () => {
  const { _resetHistory } = await import('../src/agent/history.js');
  resetMock(); _resetHistory();
  const today = new Date().toISOString().slice(0, 10);
  const ov = await call('GET', `/api/overview?today=${today}`);
  const chen = ov.body.rows.find((r) => r.recipient.business === 'Chen Bakery');
  assert.equal(chen.next.action, 'remind');
  const sent = await call('POST', `/api/invoices/${chen.id}/remind`, { subject: 's', note: 'n', today });
  assert.ok(sent.body.invoice.last_reminder);
  const ov2 = await call('GET', `/api/overview?today=${today}`);
  assert.equal(ov2.body.rows.find((r) => r.id === chen.id).next.action, 'wait');
});

test('public demo guard: sample mode, recipient allow-list and daily write cap', async () => {
  const { _resetGuard } = await import('../src/guard.js');
  const { _resetTokenCache } = await import('../src/paypal/client.js');
  _resetGuard(); _resetTokenCache(); resetMock();
  const created = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (u.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    if (init.method === 'POST' && u.endsWith('/v2/invoicing/invoices')) { created.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'INV2-L1', status: 'DRAFT', ...JSON.parse(init.body) }), { status: 201 }); }
    return new Response('{}', { status: 200 });
  };
  try {
    const env = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', SEND_ALLOWED_EMAILS: 'buyer@personal.example.com', WRITE_DAILY_CAP: '2' };
    const req = (path, payload, headers = {}) => worker.fetch(new Request(`http://x${path}`, { method: payload ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: payload ? JSON.stringify(payload) : undefined }), env).then(async (r) => ({ status: r.status, body: await r.json() }));
    const draft = (email) => ({ draft: { recipient: { email }, items: [{ name: 'Work', unit_amount: 10 }] }, today: TODAY });
    assert.equal((await req('/api/health')).body.paypal.mode, 'live');
    assert.equal((await req('/api/health?data=sample')).body.paypal.mode, 'sample');
    assert.equal((await req('/api/invoices', draft('someone@gmail.com'))).status, 403);
    assert.equal((await req('/api/invoices', draft(''))).status, 403);
    assert.equal(created.length, 0);
    assert.equal((await req('/api/invoices', draft('buyer@personal.example.com'))).status, 201);
    assert.equal((await req('/api/invoices', draft('buyer@personal.example.com'))).status, 201);
    assert.equal((await req('/api/invoices', draft('buyer@personal.example.com'))).status, 429); // cap of 2
    assert.equal(created.length, 2);
    assert.equal((await req('/api/invoices?data=sample', draft('anyone@gmail.com'))).status, 201); // sample data never reaches PayPal
    assert.equal(created.length, 2);
    const closed = await worker.fetch(new Request('http://x/api/invoices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft('buyer@personal.example.com')) }), { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's' });
    assert.equal(closed.status, 403); // no allow-list configured -> refuse
  } finally { globalThis.fetch = realFetch; }
});

test('sample sessions are isolated per browser and can be reset', async () => {
  resetMock();
  const today = new Date().toISOString().slice(0, 10);
  const A = 'sessionAAAA1111', B = 'sessionBBBB2222';
  const ov = (s) => call('GET', `/api/overview?data=sample&session=${s}&today=${today}`);
  const okaforA = (await ov(A)).body.rows.find((r) => r.recipient.business === 'Okafor Plumbing');
  assert.equal(okaforA.next.action, 'record_payment');
  await call('POST', `/api/invoices/${okaforA.id}/payments?data=sample&session=${A}`, { tx_id: okaforA.match.tx_id, today });
  assert.equal((await ov(A)).body.rows.find((r) => r.id === okaforA.id).next.action, 'none');
  assert.equal((await ov(B)).body.rows.find((r) => r.id === okaforA.id).next.action, 'record_payment'); // B unaffected
  assert.equal((await ov(A)).body.paypal_mode, 'sample');
  assert.equal((await call('POST', `/api/sample/reset?data=sample&session=${A}`, {})).status, 200);
  assert.equal((await ov(A)).body.rows.find((r) => r.id === okaforA.id).next.action, 'record_payment');
  assert.equal((await call('POST', '/api/sample/reset', {})).status, 400); // only in sample mode
});

test('overview fetches line items for open invoices when the list omits them (as the sandbox does)', async () => {
  const { _resetTokenCache } = await import('../src/paypal/client.js');
  _resetTokenCache();
  const realFetch = globalThis.fetch;
  let gets = 0;
  const inv = { id: 'INV2-A', status: 'SENT', detail: { currency_code: 'USD', invoice_number: '9', payment_term: { due_date: '2026-10-01' } }, primary_recipients: [{ billing_info: { business_name: 'Studio Vogel', email_address: 'lena@vogel.example.com' } }], amount: { currency_code: 'USD', value: '360.00' }, due_amount: { currency_code: 'USD', value: '360.00' } };
  globalThis.fetch = async (u) => {
    if (u.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    if (u.includes('/v2/invoicing/invoices?')) return new Response(JSON.stringify({ items: [inv] }), { status: 200 }); // no line items
    if (u.includes('/v2/invoicing/invoices/INV2-A')) { gets++; return new Response(JSON.stringify({ ...inv, items: [{ name: 'Product photo retouching', quantity: '24', unit_amount: { currency_code: 'USD', value: '15.00' } }] }), { status: 200 }); }
    if (u.includes('/v1/reporting/transactions')) return new Response(JSON.stringify({ last_refreshed_datetime: '2026-10-17T00:00:00Z', transaction_details: [{ transaction_info: { transaction_id: 'T9', transaction_status: 'S', transaction_amount: { currency_code: 'USD', value: '360.00' }, transaction_note: 'photo retouching' }, payer_info: { email_address: 'x@other.example.com', payer_name: { alternate_full_name: 'L. Vogel' } } }] }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  try {
    const res = await worker.fetch(new Request(`http://x/api/overview?today=${TODAY}`), { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's' });
    const body = await res.json();
    assert.equal(gets, 1);
    const row = body.rows[0];
    assert.equal(row.next.action, 'record_payment');
    assert.ok(row.match.reasons.some((r) => /note mentions/.test(r)), JSON.stringify(row.match.reasons));
    assert.equal(body.transactions_refreshed_at, '2026-10-17T00:00:00Z');
  } finally { globalThis.fetch = realFetch; }
});

test('rule reader on typical requests (used when the daily AI cap is reached)', () => {
  const r1 = ruleExtract('Could you send the invoice for the logo package ($850) and the business card layout ($150)? Please make it out to Brightside Bakery, attention Maya Ortiz, maya@b.example.com. Net 15 is fine.', TODAY);
  assert.deepEqual(r1.items.map((i) => [i.name, i.quantity, i.unit_amount]), [['logo package', 1, 850], ['business card layout', 1, 150]]);
  assert.deepEqual([r1.recipient.name, r1.recipient.business, r1.due_date], ['Maya Ortiz', 'Brightside Bakery', '2026-11-16']);
  const r3 = ruleExtract('For the product shoot on Oct 12: half-day session $600, plus 25 edited photos at $12 each. We already paid the $200 deposit by bank transfer, so please take that off. We need it paid by Nov 20.', TODAY);
  assert.deepEqual(r3.items.map((i) => [i.quantity, i.unit_amount]), [[1, 600], [25, 12]]); // the deposit is not an item
  assert.equal(r3.due_date, '2026-11-20');
  const r7 = ruleExtract("The pitch deck redesign (12 slides at $40/slide) came out great. As agreed there's a $100 rush fee, and you offered 10% off the slides.", TODAY);
  assert.deepEqual(r7.items.map((i) => [i.name, i.quantity, i.unit_amount]), [['pitch deck redesign', 12, 40], ['rush fee', 1, 100]]);
  assert.equal(ruleExtract('hey! 20 hrs of site maintenance at $45/hr, due end of the month pls', TODAY).due_date, '2026-11-30');
  assert.equal(ruleExtract('8 illustrations at EUR 180 each. Payment within 21 days.', TODAY).currency, 'EUR');
  assert.equal(ruleExtract('8 illustrations at EUR 180 each. Payment within 21 days.', TODAY).due_date, '2026-11-22');
});
