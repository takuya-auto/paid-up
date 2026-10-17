# Sandbox verification log

Every PayPal call is written from PayPal's published OpenAPI schema first and ticked here only after it
has been run against the sandbox with real credentials (team rule: verify real APIs before relying on them).

| Call | Verified | Date | Notes (debug ids go in the private log, not here) |
|---|---|---|---|
| POST /v1/oauth2/token (client credentials) | no | | expires_in, token reuse |
| POST /v2/invoicing/invoices (Prefer: return=representation) | no | | does 201 return the full invoice or only a link? |
| GET /v2/invoicing/invoices/{id} | no | | metadata.recipient_view_url present after send? |
| GET /v2/invoicing/invoices?page_size=100&total_required=true | no | | |
| POST /v2/invoicing/invoices/{id}/send | no | | 200 vs 202; status becomes SENT/UNPAID? |
| Pay the invoice as the sandbox buyer | no | | status PAID; payments.transactions[].payment_id = transaction id? |
| POST /v2/invoicing/invoices/{id}/remind | no | | 204; last_sent_time updated? |
| POST /v2/invoicing/invoices/{id}/payments | no | | external payment -> MARKED_AS_PAID / PARTIALLY_PAID |
| GET /v1/reporting/transactions | no | | how long until a sandbox payment appears; invoice_id / paypal_invoice_id on invoice payments; direct transfer from buyer shows payer_info |

Decision rule (plan, 2026-10-22): if create -> send -> pay -> status change does not work in the sandbox, switch to the Orders v2 plan.

## How to run (about 15 minutes once credentials exist)
1. Put `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` (sandbox app) into `.dev.vars` (git-ignored).
2. `node scripts/sandbox-check.mjs create <sandbox-buyer-email>` - creates and sends invoice A (due in 14 days) and B (3 days overdue). Note the two ids.
3. Log in to the sandbox as the buyer (sandbox.paypal.com, the fictional test account) and pay invoice A.
4. `node scripts/sandbox-check.mjs status <A> <B>` - A should be PAID; check whether payment_ids hold the transaction id.
5. `node scripts/sandbox-check.mjs remind <B>` - last_sent should move.
6. `node scripts/sandbox-check.mjs record <B> 40` - B should become PARTIALLY_PAID with due 60.00.
7. As the buyer, send money directly (not through an invoice) to the sandbox merchant, then run
   `node scripts/sandbox-check.mjs transactions 7` - see when it appears and whether invoice payments carry invoice_ref.
8. Tick the table above. Debug ids stay in media/sandbox-check.log (git-ignored).
