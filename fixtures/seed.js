// Fictional seed data for the mock (all names and emails are made up; example.com is reserved).
// Dates are relative to "now" so the demo always has something overdue, due soon and paid.

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const iso = (offset) => new Date(Date.now() + offset * 86400000).toISOString();
const usd = (v) => ({ currency_code: 'USD', value: v });

function inv(id, number, status, { name, business, email }, items, { issued, due, sent, paid = [] }) {
  const total = items.reduce((s, it) => s + Number(it.quantity) * Number(it.unit_amount.value), 0);
  const paidSum = paid.reduce((s, p) => s + Number(p.amount.value), 0);
  const [given, ...rest] = name.split(' ');
  return {
    id,
    status,
    detail: {
      currency_code: 'USD',
      invoice_number: number,
      invoice_date: day(issued),
      payment_term: { due_date: day(due) },
      metadata: {
        create_time: iso(issued),
        ...(sent !== undefined ? { first_sent_time: iso(sent), last_sent_time: iso(sent), recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${id}` } : {}),
      },
    },
    primary_recipients: [{ billing_info: { name: { given_name: given, surname: rest.join(' ') }, business_name: business, email_address: email } }],
    items,
    amount: usd(total.toFixed(2)),
    payments: { paid_amount: usd(paidSum.toFixed(2)), transactions: paid },
    due_amount: usd(Math.max(0, total - paidSum).toFixed(2)),
  };
}

const item = (name, quantity, value) => ({ name, quantity: String(quantity), unit_amount: usd(value) });

export const SEED_INVOICES = [
  inv('INV2-SEED-0001', '0001', 'SENT', { name: 'Maya Chen', business: 'Chen Bakery', email: 'maya@chen-bakery.example.com' },
    [item('Menu board redesign', 1, '450.00'), item('Print-ready files', 1, '80.00')],
    { issued: -40, due: -25, sent: -40 }),
  inv('INV2-SEED-0002', '0002', 'SENT', { name: 'Tom Okafor', business: 'Okafor Plumbing', email: 'tom@okafor-plumbing.example.com' },
    [item('Website copy (5 pages)', 5, '120.00')],
    { issued: -20, due: -6, sent: -20 }),
  inv('INV2-SEED-0003', '0003', 'SENT', { name: 'Lena Vogel', business: 'Studio Vogel', email: 'lena@studio-vogel.example.com' },
    [item('Product photo retouching', 24, '15.00')],
    { issued: -5, due: 9, sent: -5 }),
  inv('INV2-SEED-0004', '0004', 'PAID', { name: 'Sam Rivera', business: 'Rivera Fitness', email: 'sam@rivera-fitness.example.com' },
    [item('Class schedule spreadsheet', 1, '300.00')],
    { issued: -30, due: -15, sent: -30, paid: [{ payment_id: 'SEEDPAY0004', method: 'PAYPAL', payment_date: day(-18), amount: usd('300.00') }] }),
  inv('INV2-SEED-0005', '0005', 'PARTIALLY_PAID', { name: 'Priya Nair', business: 'Nair Tutoring', email: 'priya@nair-tutoring.example.com' },
    [item('Booking page setup', 1, '600.00')],
    { issued: -35, due: -20, sent: -35, paid: [{ payment_id: 'SEEDPAY0005', method: 'PAYPAL', payment_date: day(-21), amount: usd('300.00') }] }),
];

// Money that arrived outside the invoice link (e.g. a direct PayPal transfer). The agent's job
// is to notice which open invoice it most likely settles.
export const SEED_TRANSACTIONS = [
  {
    transaction_info: {
      transaction_id: 'SEEDTXN-A1', transaction_event_code: 'T0000', transaction_status: 'S',
      transaction_initiation_date: iso(-2), transaction_amount: usd('600.00'),
      transaction_note: 'for the website copy, thanks!',
    },
    payer_info: { email_address: 'accounts@okafor-plumbing.example.com', payer_name: { alternate_full_name: 'Okafor Plumbing LLC' } },
  },
  {
    transaction_info: {
      transaction_id: 'SEEDTXN-B2', transaction_event_code: 'T0000', transaction_status: 'S',
      transaction_initiation_date: iso(-1), transaction_amount: usd('75.00'),
      transaction_note: 'coffee meetup split',
    },
    payer_info: { email_address: 'friend@example.com', payer_name: { alternate_full_name: 'Jordan Lee' } },
  },
];
