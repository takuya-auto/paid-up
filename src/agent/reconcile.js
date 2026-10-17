// Match money that arrived outside the invoice link (direct PayPal transfers) to open invoices.
// Pure scoring: every match comes with the reasons that produced it, and nothing is recorded
// until the user confirms it.

import { OPEN_STATUSES } from '../paypal/build.js';

const STOP = new Set(['the', 'for', 'and', 'with', 'from', 'thanks', 'thank', 'you', 'invoice', 'payment', 'llc', 'inc', 'ltd', 'co']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
const domain = (e) => String(e || '').toLowerCase().split('@')[1] || '';

/** Incoming, completed transactions from a Transaction Search response. */
export function incoming(searchResponse) {
  return (searchResponse?.transaction_details || [])
    .map((t) => {
      const ti = t.transaction_info || {};
      const p = t.payer_info || {};
      return {
        id: ti.transaction_id,
        status: ti.transaction_status,
        amount: ti.transaction_amount?.value,
        currency: ti.transaction_amount?.currency_code,
        date: (ti.transaction_initiation_date || '').slice(0, 10),
        note: [ti.transaction_note, ti.transaction_subject].filter(Boolean).join(' '),
        invoice_ref: ti.invoice_id || t.cart_info?.paypal_invoice_id || null,
        payer: p.payer_name?.alternate_full_name || [p.payer_name?.given_name, p.payer_name?.surname].filter(Boolean).join(' ') || p.email_address || 'unknown payer',
        email: p.email_address || '',
      };
    })
    .filter((t) => t.status === 'S' && Number(t.amount) > 0);
}

export function scorePair(tx, row) {
  const reasons = [];
  let score = 0;
  if (tx.currency !== row.currency) return { score: 0, reasons: ['different currency'] };
  if (Number(tx.amount).toFixed(2) === Number(row.due).toFixed(2)) { score += 50; reasons.push('amount equals the balance due'); }
  else if (Number(tx.amount).toFixed(2) === Number(row.total).toFixed(2)) { score += 35; reasons.push('amount equals the invoice total'); }
  else if (Number(tx.amount) < Number(row.due)) { score += 5; reasons.push('could be a partial payment'); }
  else return { score: 0, reasons: ['amount is larger than the balance'] };
  if (tx.email && row.recipient.email && tx.email.toLowerCase() === row.recipient.email.toLowerCase()) { score += 40; reasons.push('same email as the client'); }
  else if (domain(tx.email) && domain(tx.email) === domain(row.recipient.email)) { score += 25; reasons.push(`same email domain (${domain(tx.email)})`); }
  const nameWords = new Set([...words(row.recipient.name), ...words(row.recipient.business)]);
  const payerHits = words(tx.payer).filter((w) => nameWords.has(w));
  if (payerHits.length) { score += 15; reasons.push(`payer name matches "${payerHits.join(' ')}"`); }
  const itemWords = new Set(row.items.flatMap((i) => words(i.name)));
  const noteHits = words(tx.note).filter((w) => itemWords.has(w));
  if (noteHits.length) { score += 10; reasons.push(`note mentions "${noteHits.join(' ')}"`); }
  return { score, reasons };
}

/**
 * @returns {matches:[{invoice_id, tx_id, score, reasons, ...}], unmatched:[tx]}
 * Greedy one-to-one assignment by score; only matches with score >= threshold are proposed.
 */
export function reconcile(rows, txs, { threshold = 60 } = {}) {
  const open = rows.filter((r) => OPEN_STATUSES.has(r.status));
  const knownPaymentIds = new Set(rows.flatMap((r) => r._payment_ids || []));
  const candidates = txs.filter((t) => !knownPaymentIds.has(t.id) && !t.invoice_ref);
  const pairs = [];
  for (const tx of candidates) for (const row of open) {
    const s = scorePair(tx, row);
    if (s.score >= threshold) pairs.push({ tx, row, ...s });
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedTx = new Set();
  const usedInv = new Set();
  const matches = [];
  for (const p of pairs) {
    if (usedTx.has(p.tx.id) || usedInv.has(p.row.id)) continue;
    usedTx.add(p.tx.id); usedInv.add(p.row.id);
    matches.push({
      invoice_id: p.row.id, invoice_number: p.row.number, tx_id: p.tx.id, score: p.score, reasons: p.reasons,
      amount: p.tx.amount, currency: p.tx.currency, payer: p.tx.payer, date: p.tx.date,
      settles: Number(p.tx.amount) >= Number(p.row.due) ? 'full' : 'partial',
    });
  }
  return { matches, unmatched: candidates.filter((t) => !usedTx.has(t.id)) };
}
