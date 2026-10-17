# Sandbox verification log

Every PayPal call is written from PayPal's published OpenAPI schema first and ticked here only after it
has been run against the sandbox with real credentials (team rule: verify real APIs before relying on them).

| Call | Verified | Date | Notes (debug ids go in the private log, not here) |
|---|---|---|---|
| POST /v1/oauth2/token (client credentials) | yes | 2026-10-17 | token reused across calls in one run |
| POST /v2/invoicing/invoices (Prefer: return=representation) | yes | 2026-10-17 | returns the full invoice (id, status, detail, amount, links...). USD works on the JP sandbox account. A due date in the past is accepted |
| GET /v2/invoicing/invoices/{id} | yes | 2026-10-17 | recipient_view_url present after send; invoice numbers 0001, 0002 auto-assigned |
| GET /v2/invoicing/invoices?page_size=100&total_required=true | yes | 2026-10-17 | total_items and amount/due_amount/payments are returned, but line items are NOT -> the 'note mentions an invoiced item' matching reason needs a per-invoice GET (todo) |
| POST /v2/invoicing/invoices/{id}/send | yes | 2026-10-17 | returns a link (href, rel, method); status becomes SENT |
| Pay the invoice as the sandbox buyer | not done | 2026-10-17 | decided not to run (no buyer login by the team or owner). Instead a full external payment was recorded on invoice A: 42 of 42 -> MARKED_AS_PAID, due 0.00 |
| POST /v2/invoicing/invoices/{id}/remind | yes | 2026-10-17 | succeeds, but metadata.last_sent_time is NOT updated -> the app keeps its own reminder record (src/agent/history.js) |
| POST /v2/invoicing/invoices/{id}/payments | yes | 2026-10-17 | 40 of 100 -> PARTIALLY_PAID, paid 40.00, due 60.00; PayPal assigns a payment id starting EXTR- |
| GET /v1/reporting/transactions | yes (empty) | 2026-10-17 | first 403 NOT_AUTHORIZED; after enabling Transaction Search on the app and taking a new token: 200, total_items 0, last_refreshed_datetime present (data lags real time). No real sandbox payment was made, so matching is demonstrated with the mock's sample data and labelled as such |

Result 2026-10-17: create -> send -> get/list -> remind -> record (partial and full) all work in the sandbox, so the Invoicing plan continues.

Decision rule (plan, 2026-10-22): if create -> send -> pay -> status change does not work in the sandbox, switch to the Orders v2 plan.

## How to run (about 15 minutes once credentials exist)
1. Put `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` (sandbox app) into `.dev.vars` (git-ignored).
2. `node scripts/sandbox-check.mjs create <sandbox-buyer-email>` - creates and sends invoice A (due in 14 days) and B (3 days overdue). Note the two ids.
3. The owner logs in to the sandbox as the buyer and pays invoice A (steps for the owner are kept outside this repo; the team does not type passwords).
4. `node scripts/sandbox-check.mjs status <A> <B>` - A should be PAID; check whether payment_ids hold the transaction id.
5. `node scripts/sandbox-check.mjs remind <B>` - last_sent should move.
6. `node scripts/sandbox-check.mjs record <B> 40` - B should become PARTIALLY_PAID with due 60.00.
7. The owner, as the buyer, sends USD 60 directly (not through an invoice) to the sandbox merchant; then run
   `node scripts/sandbox-check.mjs transactions 7` - see when it appears and whether invoice payments carry invoice_ref.
8. Tick the table above. Debug ids stay in media/sandbox-check.log (git-ignored).
