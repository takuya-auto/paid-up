// Turn a messy request (an email, a chat message, notes) into an invoice draft.
//
// With the LLM: ask for strict JSON plus a short quote from the source for every field, then
// check each quote really appears in the text. Fields whose quote is missing are flagged
// "check" instead of trusted. Without the LLM (daily cap reached / off): a rule-based reader
// that finds the email, amounts, quantities and a due date.

import { extractJson } from '../llm/workersai.js';

const MAX_INPUT = 6000;

const SYSTEM = `You read a freelancer's or small business's messages and draft a PayPal invoice.
Return ONLY a JSON object:
{"recipient":{"name":"","business":"","email":""},
 "items":[{"name":"","quantity":1,"unit_amount":0}],
 "currency":"USD","due_date":"YYYY-MM-DD or null","note":"",
 "evidence":{"recipient":"exact quote","items":["exact quote per item"],"due_date":"exact quote or null"}}
Rules:
- Use only facts present in the text. Never invent an email, price or date.
- unit_amount is a number per unit, without currency symbols. If only a total is given, use quantity 1.
- Resolve relative dates ("next Friday", "end of month") against TODAY.
- "evidence" quotes must be copied word-for-word from the text.
- note: one polite sentence thanking the client and naming the work, in the language of the text.`;

export async function extractDraft(text, { llm, today }) {
  const source = String(text || '').slice(0, MAX_INPUT).trim();
  if (!source) throw Object.assign(new Error('text is required'), { status: 400 });
  const trace = [];
  let draft = null;
  let via = 'rules';

  if (llm && (await llm.available())) {
    try {
      const out = await llm.chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `TODAY: ${today}\n\nTEXT:\n${source}` },
      ], { maxTokens: 700, temperature: 0 });
      const parsed = extractJson(out.text);
      if (parsed && Array.isArray(parsed.items)) {
        draft = parsed;
        via = 'llm';
      } else {
        trace.push({ step: 'llm', note: 'model did not return usable JSON; used rules' });
      }
    } catch (e) {
      trace.push({ step: 'llm', note: `LLM call failed: ${e.message}; used rules` });
    }
  } else if (llm) {
    trace.push({ step: 'llm', note: `LLM unavailable (${llm.lastReason}); used rules` });
  }

  if (!draft) draft = ruleExtract(source, today);
  const checks = verify(draft, source);
  if (via === 'rules') {
    // A quote being present does not mean the rules understood it (e.g. "12 slides at $40/slide,
    // 10% off, plus a $100 rush fee" on one line). Never present a rule-based read as checked.
    for (const c of checks) {
      if (c.field.startsWith('items[') || c.field === 'due_date') {
        c.ok = false;
        c.reason = `read by simple rules (AI unavailable): check the name, quantity and price; ${c.reason}`;
      }
    }
    const extras = source.match(/\d+\s?%|discount|\boff\b|rush fee|deposit|tax|shipping|minus|less\b/gi);
    checks.unshift({ field: 'reader', ok: false, value: 'rules', reason: `AI unavailable, so this draft was read by simple rules${extras ? `; the text mentions ${[...new Set(extras.map((e) => e.toLowerCase()))].join(', ')}, which the rules do not apply` : ''}. Please review every line.` });
    if (!draft.items.length) checks.push({ field: 'items', ok: false, value: '', reason: 'no price found; add the line items by hand' });
  }
  return { draft: clean(draft), checks, via, trace };
}

/** Deterministic reader used when the LLM is unavailable. */
export function ruleExtract(text, today) {
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [''])[0];
  const currency = /€|\bEUR\b/i.test(text) ? 'EUR' : /£|\bGBP\b/i.test(text) ? 'GBP' : /¥|\bJPY\b|円/.test(text) ? 'JPY' : 'USD';
  const items = [];
  const evidenceItems = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/(?:\$|€|£|¥|USD\s*|EUR\s*)\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(?:USD|EUR|dollars|円)/i);
    if (!m) continue;
    const amount = Number((m[1] || m[2]).replace(/,/g, ''));
    if (!amount) continue;
    const qty = Number((line.match(/(\d+)\s?(?:x|×|pcs|hours?|hrs?|pages?|units?)\b/i) || [])[1]) || 1;
    const perUnit = /\b(?:each|per|\/\s?(?:hr|hour|page|unit))\b/i.test(line) || qty === 1 ? amount : amount / qty;
    const name = line.replace(m[0], '').replace(/[-–:•*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Services';
    items.push({ name, quantity: qty, unit_amount: Number(perUnit.toFixed(2)) });
    evidenceItems.push(line.trim());
  }
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  const greet = text.match(/^(?:hi|hello|dear)\s+([A-Z][a-z]+)/im);
  const sign = text.match(/^(?:thanks|best|regards|cheers)[,!]?\s*\n\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/im);
  return {
    recipient: { name: (sign && sign[1]) || '', business: '', email },
    items,
    currency,
    due_date: iso ? iso[1] : null,
    note: 'Thank you for your business.',
    evidence: { recipient: email || (sign && sign[1]) || null, items: evidenceItems, due_date: iso ? iso[1] : null },
    _greeting: greet ? greet[1] : null,
    _today: today,
  };
}

/** Check every quoted piece of evidence against the source text. */
export function verify(draft, source) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const src = norm(source);
  const has = (q) => !!q && src.includes(norm(q));
  const ev = draft.evidence || {};
  const checks = [];
  const email = draft.recipient?.email;
  checks.push({ field: 'recipient.email', ok: !email || src.includes(email.toLowerCase()), value: email || '', reason: !email ? 'no email found; add one or the invoice is created without notification' : src.includes(email.toLowerCase()) ? 'found in text' : 'email not present in the text' });
  checks.push({ field: 'recipient', ok: has(ev.recipient), value: draft.recipient?.name || draft.recipient?.business || '', reason: has(ev.recipient) ? 'quoted from text' : 'not quoted from text; please check' });
  (draft.items || []).forEach((it, i) => {
    const q = Array.isArray(ev.items) ? ev.items[i] : null;
    const priceSeen = src.includes(String(it.unit_amount)) || src.includes(Number(it.unit_amount).toLocaleString('en-US'));
    checks.push({ field: `items[${i}]`, ok: has(q) && priceSeen, value: `${it.quantity} x ${it.unit_amount} ${it.name}`, reason: !has(q) ? 'not quoted from text; please check' : priceSeen ? 'price found in text' : 'price is computed (e.g. total split per unit); please check' });
  });
  if (draft.due_date) checks.push({ field: 'due_date', ok: has(ev.due_date), value: draft.due_date, reason: has(ev.due_date) ? `from "${ev.due_date}"` : 'date was inferred; please check' });
  return checks;
}

function clean(d) {
  return {
    recipient: { name: d.recipient?.name || '', business: d.recipient?.business || '', email: d.recipient?.email || '' },
    items: (d.items || []).map((it) => ({ name: String(it.name || '').trim(), quantity: Number(it.quantity) || 1, unit_amount: Number(it.unit_amount) || 0 })),
    currency: (d.currency || 'USD').toUpperCase(),
    due_date: d.due_date && /^\d{4}-\d{2}-\d{2}$/.test(d.due_date) ? d.due_date : null,
    note: d.note || '',
  };
}
