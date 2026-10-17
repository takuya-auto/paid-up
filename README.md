# Paid-Up

**An AI collections assistant for freelancers on PayPal Invoicing.**
Paste a client's message and get a PayPal invoice draft. See who to chase next and why. Match the money that came in. Sending, reminding and recording are separate actions you trigger yourself.

> DRAFT README (2026-10-17). Items marked **TODO** are filled in after the PayPal sandbox run (`docs/sandbox-check.md`). Nothing here is final until then.

- **Live demo:** TODO (Cloudflare Workers URL). It runs against the PayPal **sandbox**, so no real money moves.
- **Demo video (under 3 min):** TODO (YouTube URL)
- **License:** MIT

## The problem

Sending an invoice is the easy part. The hard part comes after it: noticing who hasn't paid, deciding how hard to nudge, writing that awkward email, and working out which incoming payment belongs to which invoice. Freelancers and one-person businesses do this from memory and a spreadsheet, and the money that slips through is money they already earned.

## What it does

1. **Message → invoice draft.** Paste an email or chat message ("20 hrs of maintenance at $45/hr, due end of the month"). The AI turns it into line items, quantities, prices, the client and a due date. Every field is checked against the original text. Anything that is not found word for word is flagged for you to confirm. You can edit lines in the grid, and only then is a **draft** invoice created at PayPal. The client gets nothing yet.
2. **Who to chase next.** All invoices sit in one board, sorted by what needs doing today: *send*, *remind*, *record payment*, *wait* or *nothing*. Each row has a plain-English reason ("25 days overdue; last contact 40 days ago"). The decision is rule-based on purpose. When money is involved, the "what" should be predictable and explainable.
3. **Reminders in the right tone.** For an overdue invoice Paid-Up suggests a tone (friendly nudge → firm follow-up → final notice) from days overdue and the last time you contacted the client, and the AI drafts the message. You edit it, tick the confirmation and PayPal sends it with the payment link. Paid-Up records when you sent a reminder (PayPal's invoice metadata does not change on a reminder) and won't suggest another one within 5 days.
4. **Matching incoming money.** Payments don't always come through the invoice link. Paid-Up searches your PayPal transactions and proposes which open invoice each payment settles, showing the reasons (amount equals the balance or the total, same email or email domain as the client, payer name matches, the payment note mentions an invoiced item). You confirm, and it is recorded on the invoice. A payment that matches nothing is listed for you to review; recording happens only through the *Record payment* action.
5. **Everything is visible.** A log shows every PayPal call (method, path, status) and every AI step, including when the app fell back to rules.

### Human in the loop, by design

| Action | What the AI does | What you do |
|---|---|---|
| Create an invoice | Reads the message into a draft and flags anything it could not find in the text | Edit, then click *Create draft at PayPal* |
| Send an invoice | — | Tick "I checked the amount and the client", then *Send* |
| Remind | Picks a tone and drafts the wording | Edit, tick, then *Send reminder* |
| Record a payment | Proposes a match with reasons | Tick, then *Record payment at PayPal* |

## PayPal technology used

| PayPal API | Used for |
|---|---|
| OAuth 2.0 client credentials (`/v1/oauth2/token`) | Server-side access token, refreshed before it expires |
| Invoicing v2: create (`POST /v2/invoicing/invoices`) | Draft invoice from the reviewed draft |
| Invoicing v2: list / get | The board and the detail panel |
| Invoicing v2: send (`…/{id}/send`) | Sending the invoice with PayPal's pay link |
| Invoicing v2: remind (`…/{id}/remind`) | Sending the reminder you approved |
| Invoicing v2: record payment (`…/{id}/payments`) | Recording a confirmed match (full or partial) |
| Transaction Search (`GET /v1/reporting/transactions`) | Finding incoming payments to match against open invoices |

Sandbox verification status: TODO (copy the ticked table from `docs/sandbox-check.md`).

## AI used, and how

- **Model:** Meta Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on Cloudflare Workers AI.
- **Where the model is used:**
  - reading a messy message into a structured invoice draft (JSON);
  - writing a reminder in a chosen tone, from the invoice's facts only.
- **Where it is deliberately *not* used:** the next-action rules and payment matching are deterministic and tested, so that "who gets chased" and "which payment is recorded" can always be explained.
- **Guardrails:**
  - the model's draft is checked word for word against the source text;
  - for reminders, the model is given only the invoice's own facts, and links or threats (legal action, collections, late fees) are stripped from its wording;
  - calls that change something at PayPal are separate API endpoints, and the UI only calls them after you tick the confirmation and click.
- **Budget and fallback:** a daily cap on model calls (`LLM_DAILY_CAP`, default 60) and a per-request cap. When the AI is unavailable or the cap is used up, Paid-Up keeps working. It reads messages with rules (and flags those reads for review) and writes reminders from templates. The header shows which mode is active.
- **Development:** built with AI coding agents (Claude Code) as the main development tool.

## Architecture

```
Browser (public/: plain JS + AG Grid Community)
   │  /api/*  (JSON, see docs/api.md)
   ▼
Cloudflare Worker (src/worker.js)
   ├─ src/agent/extract.js    message → draft + checks   (LLM, rule fallback)
   ├─ src/agent/collect.js    next action + reminder text (rules + LLM wording)
   ├─ src/agent/reconcile.js  payment ↔ invoice matching (rules, with reasons)
   ├─ src/llm/workersai.js    Workers AI with daily cap
   └─ src/paypal/client.js    PayPal REST (sandbox) — or a built-in mock without credentials
```

The board is built on **AG Grid Community** (MIT):
- custom cell renderers for the next step, status, days overdue and inline actions;
- sorting by urgency, filter chips (external filter), quick search and tooltips with the reason;
- a pinned total row that follows the active filter;
- CSV export;
- the line items of a draft are edited directly in a second grid before anything is sent to PayPal.

## Run it yourself

Requirements: Node.js (current LTS), a Cloudflare account (free plan) for Workers AI, a PayPal developer **sandbox** app.

```bash
git clone TODO
cd TODO   # folder name decided when the public repo is created
cp .dev.vars.example .dev.vars   # add PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox)
npx wrangler dev                 # http://localhost:8787
npm test                         # unit tests (node --test)
```

Without PayPal credentials the Worker uses a built-in mock with fictional invoices, so you can try the whole flow offline.

## Try it as a judge

- Open the live demo (TODO URL). It is connected to a PayPal sandbox business account.
- To pay an invoice as a client, use the sandbox **buyer** test account: TODO (sandbox-only test credentials, added before submission as the rules allow).
- Sample messages to paste are in the *Try a sample message* menu (all clients are fictional; emails use the reserved `example.com` / `example.org` domains).

## What's next

- Recurring invoices for retainers
- Per-client reminder history and "usually pays N days late" in the reason text
- Multi-currency totals on the board

## License

MIT. See `LICENSE`. AG Grid Community is MIT-licensed (`public/vendor/ag-grid-community-LICENSE.txt`).
