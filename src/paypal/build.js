// Pure helpers between our "draft" shape and PayPal Invoicing v2 shapes.
// Field names follow PayPal's published Invoicing v2 schema (invoice, invoice_detail,
// item, money, recipient_info, notification, payment_detail).

export const OPEN_STATUSES = new Set(['SENT', 'UNPAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'SCHEDULED', 'SHARED']);
export const PAID_STATUSES = new Set(['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL']);
export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CHECK', 'CREDIT_CARD', 'DEBIT_CARD', 'PAYPAL', 'WIRE_TRANSFER', 'OTHER'];

const money = (currency, value) => ({ currency_code: currency, value: toAmount(value) });

/** Two-decimal string, as PayPal expects for money values. */
export function toAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error(`Invalid amount: ${v}`), { status: 400 });
  return n.toFixed(2);
}

/**
 * Validate a draft produced by the extractor (or edited by the user) and normalise it.
 * Throws {status:400} on anything we must not send to PayPal.
 */
export function validateDraft(d) {
  const err = (m) => Object.assign(new Error(m), { status: 400 });
  if (!d || typeof d !== 'object') throw err('draft is required');
  const currency = String(d.currency || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw err('currency must be a 3-letter code');
  const email = String(d.recipient?.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err('recipient.email is not an email address');
  const items = (Array.isArray(d.items) ? d.items : []).map((it) => ({
    name: String(it.name || '').trim().slice(0, 200),
    description: it.description ? String(it.description).slice(0, 1000) : undefined,
    quantity: String(Number(it.quantity ?? 1) || 1),
    unit_amount: toAmount(it.unit_amount ?? it.price ?? 0),
  })).filter((it) => it.name);
  if (!items.length) throw err('at least one line item is required');
  if (items.every((it) => Number(it.unit_amount) === 0)) throw err('line items have no price');
  const due = d.due_date ? String(d.due_date).slice(0, 10) : null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw err('due_date must be YYYY-MM-DD');
  return {
    currency,
    recipient: {
      name: String(d.recipient?.name || '').trim().slice(0, 140),
      business: String(d.recipient?.business || '').trim().slice(0, 300),
      email,
    },
    items,
    due_date: due,
    term: due ? 'DUE_ON_DATE_SPECIFIED' : (d.term || 'NET_15'),
    note: d.note ? String(d.note).slice(0, 4000) : '',
    reference: d.reference ? String(d.reference).slice(0, 120) : '',
  };
}

/** Our validated draft -> PayPal `invoice` request body. */
export function toPayPalInvoice(draft, { invoicerEmail } = {}) {
  const d = validateDraft(draft);
  const [given, ...rest] = d.recipient.name.split(/\s+/).filter(Boolean);
  const body = {
    detail: {
      currency_code: d.currency,
      note: d.note || undefined,
      reference: d.reference || undefined,
      payment_term: d.due_date ? { due_date: d.due_date } : { term_type: d.term },
    },
    primary_recipients: [{
      billing_info: {
        ...(given ? { name: { given_name: given, surname: rest.join(' ') || undefined } } : {}),
        ...(d.recipient.business ? { business_name: d.recipient.business } : {}),
        ...(d.recipient.email ? { email_address: d.recipient.email } : {}),
      },
    }],
    items: d.items.map((it) => ({
      name: it.name,
      description: it.description,
      quantity: it.quantity,
      unit_amount: money(d.currency, it.unit_amount),
      unit_of_measure: 'QUANTITY',
    })),
  };
  if (invoicerEmail) body.invoicer = { email_address: invoicerEmail };
  return JSON.parse(JSON.stringify(body)); // drop undefined
}

/** Days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** PayPal `invoice` -> the flat row the UI and the agent work with. */
export function summarize(inv, today) {
  const detail = inv.detail || {};
  const billing = inv.primary_recipients?.[0]?.billing_info || {};
  const name = [billing.name?.given_name, billing.name?.surname].filter(Boolean).join(' ');
  const total = inv.amount?.value ?? sumItems(inv.items);
  const currency = inv.amount?.currency_code || detail.currency_code || 'USD';
  const paid = inv.payments?.paid_amount?.value ?? '0.00';
  const due = inv.due_amount?.value ?? (Number(total) - Number(paid)).toFixed(2);
  const dueDate = detail.payment_term?.due_date || null;
  const sentAt = detail.metadata?.first_sent_time || null;
  const lastSentAt = detail.metadata?.last_sent_time || null;
  return {
    id: inv.id,
    number: detail.invoice_number || null,
    status: inv.status || 'DRAFT',
    recipient: { name, business: billing.business_name || '', email: billing.email_address || '' },
    currency,
    total: String(total),
    paid: String(paid),
    due: String(due),
    invoice_date: detail.invoice_date || null,
    due_date: dueDate,
    first_sent: sentAt,
    last_sent: lastSentAt,
    days_overdue: dueDate && today && OPEN_STATUSES.has(inv.status) ? Math.max(0, daysBetween(dueDate, today)) : 0,
    payer_url: detail.metadata?.recipient_view_url || null,
    items: (inv.items || []).map((it) => ({ name: it.name, quantity: it.quantity, unit_amount: it.unit_amount?.value })),
    note: detail.note || '',
    // ids already settled against this invoice: PayPal's own payment ids, plus transaction ids we
    // wrote into the note when the user confirmed a match (so it is not proposed twice)
    _payment_ids: (inv.payments?.transactions || []).flatMap((t) => [t.payment_id, (String(t.note || '').match(/transaction (\S+)/) || [])[1]]).filter(Boolean),
  };
}

function sumItems(items = []) {
  return items.reduce((s, it) => s + Number(it.quantity || 1) * Number(it.unit_amount?.value || 0), 0).toFixed(2);
}
