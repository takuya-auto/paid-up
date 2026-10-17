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

// JSON schema for Workers AI JSON mode (keeps the model to the shape we parse).
const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    recipient: { type: 'object', properties: { name: { type: 'string' }, business: { type: 'string' }, email: { type: 'string' } } },
    items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, quantity: { type: 'number' }, unit_amount: { type: 'number' } }, required: ['name', 'quantity', 'unit_amount'] } },
    currency: { type: 'string' },
    due_date: { type: ['string', 'null'] },
    note: { type: 'string' },
    evidence: { type: 'object', properties: { recipient: { type: ['string', 'null'] }, items: { type: 'array', items: { type: 'string' } }, due_date: { type: ['string', 'null'] } } },
  },
  required: ['recipient', 'items', 'currency', 'evidence'],
};

// Words for adjustments an invoice line cannot express (validateDraft refuses negative prices).
const ADJUST = /\d+\s?%|discount|\boff\b|rush fee|deposit|already paid|tax|shipping|minus|\bless\b/gi;

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
      ], { maxTokens: 900, temperature: 0, responseFormat: { type: 'json_schema', json_schema: DRAFT_SCHEMA } });
      const parsed = extractJson(out.text);
      if (parsed && Array.isArray(parsed.items)) {
        draft = parsed;
        via = 'llm';
      } else {
        trace.push({ step: 'llm', note: `model did not return usable JSON; used rules (output began: ${JSON.stringify(String(out.text || '').slice(0, 120))})` });
      }
    } catch (e) {
      trace.push({ step: 'llm', note: `LLM call failed: ${e.message}; used rules` });
    }
  } else if (llm) {
    trace.push({ step: 'llm', note: `LLM unavailable (${llm.lastReason}); used rules` });
  }

  if (!draft) draft = ruleExtract(source, today);
  const checks = verify(draft, source);
  if (via === 'llm') {
    // The model may silently ignore "take the $200 deposit off" or "10% off". Say so.
    const named = (draft.items || []).map((i) => String(i.name).toLowerCase()).join(' ');
    const hits = [...new Set((source.match(ADJUST) || []).map((e) => e.toLowerCase()))].filter((e) => !named.includes(e.replace(/\d+\s?/, '').trim()));
    if (hits.length) checks.unshift({ field: 'adjustments', ok: false, value: hits.join(', '), reason: `The text mentions ${hits.join(', ')}. Check that the line items and total reflect it; discounts and deposits are not applied automatically.` });
  }
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

/** Deterministic reader used when the LLM is unavailable. Handles the common shapes
 *  ("20 hrs at $45/hr", "25 photos at $12 each", "6 sessions x $35", "logo package ($850)"),
 *  plain due dates ("Nov 20", "2026-11-20", "net 30", "within 21 days", "end of the month") and
 *  "bill to / invoice to / attention" names. Anything it cannot apply (discounts, deposits) is
 *  named in the review warning by extractDraft. */
export function ruleExtract(text, today) {
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [''])[0];
  const currency = /€|\bEUR\b/i.test(text) ? 'EUR' : /£|\bGBP\b/i.test(text) ? 'GBP' : /¥|\bJPY\b|円/.test(text) ? 'JPY' : 'USD';
  const MONEY = /(?:\$|€|£|¥|\b(?:USD|EUR|GBP|JPY)\s?)\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(?:USD|EUR|dollars|円)/gi;
  const UNIT = '(?:hrs?|hours?|sessions?|slides?|photos?|pages?|words?|illustrations?|units?|items?|pcs|days?|posts?|videos?|lessons?|workshops?)';
  const items = [];
  const evidenceItems = [];
  // Clauses: sentences, then parts joined by "and the" / "plus" / ";" / ": ".
  const clauses = text.split(/(?<=[.!?])\s+|\n+/).flatMap((s) => s.split(/;|:\s|\band the\b|\bplus\b|\)\s*and\b/i));
  for (const raw of clauses) {
    const clause = raw.trim();
    if (!clause || /\b(already paid|deposit|paid the|refund)\b/i.test(clause)) continue; // money already settled: leave to the user
    for (const m of clause.matchAll(MONEY)) {
      const amount = Number((m[1] || m[2]).replace(/,/g, ''));
      if (!amount) continue;
      const before = clause.slice(0, m.index);
      const after = clause.slice(m.index + m[0].length, m.index + m[0].length + 20);
      if (/^\s*%|^\s*off\b/i.test(after) || /\b\d+\s?%\s*$/.test(before)) continue;
      const q = before.match(new RegExp(`(\\d[\\d,]*)[-\\s]+(?:[a-z-]+\\s+){0,2}${UNIT}\\b[^$€£¥]{0,25}?(?:at|@|x|×|for)?\\s*$`, 'i'))
        || before.match(/(\d[\d,]*)\s*(?:x|×)\s*$/i)
        || before.match(new RegExp(`(\\d[\\d,]*)[-\\s]*${UNIT}\\b`, 'i'));
      const qty = q ? Number(q[1].replace(/,/g, '')) : 1;
      const perUnit = /^\s*(?:\/|each|per\b|a\s|an\s)/i.test(after) || /\b(?:at|x|×|@)\s*$/i.test(before);
      const unit = qty > 1 && !perUnit ? amount / qty : amount;
      let name = before
        .replace(q ? q[0] : '', ' ')
        .replace(/\(\s*$/, '')
        .replace(/^.*?\b(?:invoice for|bill (?:us|me) for|for the|for my|for our|for|of)\s+/i, '')
        .replace(/\b(?:at|x|×|@|is|was|of)\s*$/i, '')
        .trim()
        .replace(/^(?:the|a|an|one-time|same as usual)\s+/i, '')
        .replace(/[—–(]/g, ' ').replace(/\s+/g, ' ').trim();
      if (/(?:^|\s)(?:a|an|the)$/i.test(name) || /\b(?:there's|there is|it's|it is)\b/i.test(name)) {
        // "there's a $100 rush fee": the item is named after the amount
        const named = after.match(/^\s*([a-z][a-z -]{2,40}?)(?=[,.;)]|\s+(?:and|for|since|because)\b|$)/i);
        if (named) name = named[1].trim();
      }
      name = name.replace(/[\s,;:-]+$/, '');
      if (!name || name.length < 3) name = q ? q[0].replace(/\d[\d,]*/, '').replace(/\b(?:at|x|×|@)\b/g, '').trim() : 'Services';
      items.push({ name: name.slice(0, 120), quantity: qty, unit_amount: Number(unit.toFixed(2)) });
      evidenceItems.push(clause);
    }
  }
  return {
    recipient: { name: findName(text), business: findBusiness(text), email },
    items,
    currency,
    due_date: findDue(text, today),
    note: 'Thank you for your business.',
    evidence: { recipient: email || null, items: evidenceItems, due_date: findDueQuote(text) },
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const addDays = (today, n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function findDueQuote(text) {
  const m = text.match(/\b(?:due|by|paid by|before)\s+(?:on\s+)?((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|20\d{2}-\d{2}-\d{2})|\bnet\s?(\d{1,3})\b|\b(?:within|in)\s+(\d{1,3})\s+days\b|\bend of (?:the )?month\b|\b(20\d{2}-\d{2}-\d{2})\b/i);
  return m ? m[0] : null;
}

export function findDue(text, today) {
  const q = findDueQuote(text);
  if (!q || !today) return null;
  const iso = q.match(/20\d{2}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const md = q.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/i);
  if (md) {
    const [y] = today.split('-').map(Number);
    let d = `${y}-${String(MONTHS.indexOf(md[1].toLowerCase()) + 1).padStart(2, '0')}-${md[2].padStart(2, '0')}`;
    if (d < addDays(today, -60)) d = `${y + 1}${d.slice(4)}`; // "Jan 10" written in December
    return d;
  }
  const net = q.match(/net\s?(\d{1,3})|(\d{1,3})\s+days/i);
  if (net) return addDays(today, Number(net[1] || net[2]));
  if (/end of/i.test(q)) {
    const [y, mo] = today.split('-').map(Number);
    return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  }
  return null;
}

function findBusiness(text) {
  const NAME = "([A-Z][\\w&'.-]*(?:\\s+(?:&\\s+)?[A-Z][\\w&'.-]*){0,4})";
  const m = text.match(new RegExp(`\\b(?:[Bb]ill|[Ii]nvoice|[Mm]ake it out)\\s+(?:it\\s+)?(?:to|out to)\\s+${NAME}`))
    || text.match(new RegExp(`\\b(?:please bill|bill)\\s+${NAME}`))
    || text.match(new RegExp(`\\bClient:\\s*${NAME}`));
  return m ? m[1].replace(/\s+for$/, '').trim() : '';
}

function findName(text) {
  const m = text.match(/\b(?:attention|attn\.?|contact|to me)[,:]?\s+(?:Dr\.?\s+)?([A-Z][a-z]+\s+[A-Z][a-z]+)/)
    || text.match(/,\s*([A-Z][a-z]+\s+[A-Z][a-z]+),\s*[A-Z0-9._%+-]+@/i)
    || text.match(/^(?:thanks|best|regards|cheers)[,!]?\s*\n\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/im);
  return m ? m[1] : '';
}

function numVariants(v) {
  const n = Number(v);
  const set = new Set([String(v), String(n), n.toFixed(2), n.toLocaleString('en-US'), n.toLocaleString('en-US', { minimumFractionDigits: 2 })]);
  return [...set].map((x) => x.replace(/[.]/g, '\\.'));
}
function moneyPattern(v) {
  const nums = numVariants(v).join('|');
  return new RegExp(`(?:[$€£¥]|\\b(?:USD|EUR|GBP|JPY)\\s?)\\s?(?:${nums})(?![\\d.,]*\\d)|(?<![\\d.,])(?:${nums})\\s?(?:USD|EUR|GBP|JPY|dollars|euros|円)`, 'i');
}
function rateAfter(v) {
  const nums = numVariants(v).join('|');
  return new RegExp(`(?:[$€£¥]|\\b(?:USD|EUR|GBP|JPY)\\s?)\\s?(?:${nums})(?![\\d.,]*\\d)\\s*(?:/|per\\b|each\\b|an?\\s+(?:hour|word|page|slide|session|item))`, 'i');
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
    // The price must appear as money ("$12", "EUR 180", "12 dollars"), not just as any number ("12 slides").
    const money = moneyPattern(it.unit_amount);
    const priceSeen = money.test(source);
    // "$0.09 per word" / "$45/hr" / "$12 each" with quantity 1 usually means the quantity was missed.
    const rate = Number(it.quantity) === 1 && rateAfter(it.unit_amount).test(source);
    const ok = has(q) && priceSeen && !rate;
    const reason = !has(q) ? 'not quoted from text; please check'
      : !priceSeen ? 'this price is not written as an amount in the text (computed or misread); please check'
      : rate ? 'the text gives this as a rate (per unit) but the quantity is 1; please check the quantity'
      : 'price found in text';
    checks.push({ field: `items[${i}]`, ok, value: `${it.quantity} x ${it.unit_amount} ${it.name}`, reason });
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
