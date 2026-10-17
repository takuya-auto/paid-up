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
