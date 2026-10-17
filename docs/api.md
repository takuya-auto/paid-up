# Paid-Up API (contract for the UI)

All endpoints are JSON. `today` (YYYY-MM-DD) is optional everywhere and defaults to the current UTC date;
the UI should send the user's local date. Errors: `{ "error": "...", "status": 400 }`.
Endpoints that call PayPal also return `paypal_mode` (`"mock"` or `"live"`) and `paypal_calls`
(`[{method, path, status, ms, debug_id}]`) so the UI can show what was sent to PayPal.

Nothing is ever sent to the client or recorded at PayPal without an explicit POST from the user.

## GET /api/health
`{ ok, paypal: {mode, environment}, llm: {mode, model, cap, usedToday, remaining, ...}, tones: {friendly|firm|final: {label, when}} }`

## POST /api/draft — read a messy request (no PayPal call)
Request: `{ "text": "email / chat / notes", "today": "2026-11-01" }`
Response:
```json
{
  "draft": { "recipient": {"name":"","business":"","email":""},
             "items": [{"name":"","quantity":1,"unit_amount":0}],
             "currency": "USD", "due_date": "2026-11-20" | null, "note": "" },
  "checks": [{ "field": "items[0]", "ok": true, "value": "5 x 120 Website copy", "reason": "price found in text" }],
  "via": "llm" | "rules",
  "trace": [{ "step": "llm", "note": "..." }],
  "llm": { ...status }
}
```
`checks[].ok=false` means the value was not found word-for-word in the text: highlight it for the user to confirm.

## POST /api/invoices — create the draft invoice at PayPal (not sent yet)
Request: `{ "draft": <draft as edited by the user>, "today": "..." }` → `201 { invoice: Row }`
400 if: no items, all prices 0, negative amount, bad email, bad date.

## GET /api/overview — the dashboard
Response:
```json
{
  "today": "2026-11-01",
  "rows": [Row + { "match": Match|null, "next": NextAction }],   // sorted: most urgent first
  "unmatched_payments": [Tx],
  "totals": { "outstanding": "0.00", "overdue": "0.00", "due_next_14_days": "0.00", "waiting_to_record": "0.00", "currency": "USD" },
  "transaction_search_error": null | "message"
}
```

## GET /api/invoices/:id → `{ invoice: Row }`
## POST /api/invoices/:id/send → `{ invoice: Row }` (body: optional `subject`, `note`)
## POST /api/invoices/:id/reminder-draft — AI writes the reminder (nothing sent)
Request `{ "tone": "friendly"|"firm"|"final" (optional; default from days overdue) }`
→ `{ reminder: {tone, subject, note, via: "llm"|"template"}, next: NextAction }`
## POST /api/invoices/:id/remind — send the (edited) reminder through PayPal
Request `{ "subject": "...", "note": "..." }` (both required) → `{ invoice: Row }`
## POST /api/invoices/:id/payments — record a payment (e.g. a confirmed match)
Request `{ "method": "PAYPAL"|"BANK_TRANSFER"|..., "amount": "600.00" (default: balance due), "payment_date": "YYYY-MM-DD", "tx_id": "matched transaction id", "note": "" }`
→ `{ invoice: Row }`. 400 if amount is 0 or more than the balance due.

## Shapes
**Row**: `{ id, number, status, recipient:{name,business,email}, currency, total, paid, due, invoice_date, due_date, first_sent, last_sent, days_overdue, payer_url, items:[{name,quantity,unit_amount}], note }`
Status values are PayPal's: DRAFT, SENT, UNPAID, PARTIALLY_PAID, PAYMENT_PENDING, PAID, MARKED_AS_PAID, CANCELLED, ...

**NextAction**: `{ action: "send"|"remind"|"record_payment"|"wait"|"none", tone?: "friendly"|"firm"|"final", priority: 0-5, why: "human-readable reason" }`

**Match**: `{ invoice_id, invoice_number, tx_id, score, reasons:["amount equals the balance due", ...], amount, currency, payer, date, settles: "full"|"partial" }`

**Tx**: `{ id, amount, currency, date, note, payer, email }`
