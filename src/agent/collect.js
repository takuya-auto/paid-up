// Deciding what to do next about each invoice, and drafting reminders.
// nextAction() is pure and rule-based on purpose: when money is involved the "what" should be
// predictable and explainable. The LLM is only used for the wording of a reminder.

import { OPEN_STATUSES, PAID_STATUSES, daysBetween } from '../paypal/build.js';
import { extractJson } from '../llm/workersai.js';

export const TONES = {
  friendly: { label: 'Friendly nudge', when: '1-7 days overdue' },
  firm: { label: 'Firm follow-up', when: '8-21 days overdue' },
  final: { label: 'Final notice', when: 'more than 21 days overdue' },
};

const QUIET_DAYS = 5; // do not remind the same client twice within this window

export function toneFor(daysOverdue) {
  if (daysOverdue > 21) return 'final';
  if (daysOverdue > 7) return 'firm';
  return 'friendly';
}

/**
 * @param row summary row (see paypal/build.js summarize)
 * @param today YYYY-MM-DD
 * @param match optional reconciliation match for this invoice
 * @returns {action, priority, why, tone?}
 */
export function nextAction(row, today, match = null) {
  if (PAID_STATUSES.has(row.status) || ['CANCELLED', 'REFUNDED', 'MARKED_AS_REFUNDED', 'AUTO_CANCELLED'].includes(row.status)) {
    return { action: 'none', priority: 0, why: `Invoice is ${row.status.toLowerCase().replace(/_/g, ' ')}.` };
  }
  if (row.status === 'DRAFT') return { action: 'send', priority: 2, why: 'Drafted but not sent yet.' };
  if (match) {
    return { action: 'record_payment', priority: 5, why: `A ${match.currency} ${match.amount} payment from ${match.payer} on ${match.date} looks like it settles this invoice (${match.reasons.join(', ')}).` };
  }
  if (!OPEN_STATUSES.has(row.status)) return { action: 'none', priority: 0, why: `Status ${row.status}.` };

  const lastContact = (row.last_sent || row.first_sent || '').slice(0, 10);
  const quietFor = lastContact ? daysBetween(lastContact, today) : 99;
  const partial = row.status === 'PARTIALLY_PAID' ? ` (${row.currency} ${row.paid} already paid, ${row.due} left)` : '';

  if (!row.due_date || row.days_overdue === 0) {
    const left = row.due_date ? daysBetween(today, row.due_date) : null;
    if (left !== null && left <= 2 && quietFor >= QUIET_DAYS) {
      return { action: 'remind', tone: 'friendly', priority: 2, why: `Due in ${left} day(s)${partial}; a short heads-up helps it get paid on time.` };
    }
    return { action: 'wait', priority: 1, why: left === null ? 'No due date.' : `Not due yet (${left} day(s) left)${partial}.` };
  }
  if (quietFor < QUIET_DAYS) {
    return { action: 'wait', priority: 1, why: `${row.days_overdue} day(s) overdue${partial}, but the client was contacted ${quietFor} day(s) ago. Waiting until ${QUIET_DAYS} days have passed.` };
  }
  const tone = toneFor(row.days_overdue);
  return { action: 'remind', tone, priority: tone === 'final' ? 4 : 3, why: `${row.days_overdue} day(s) overdue${partial}; last contact ${quietFor} day(s) ago.` };
}

const REMINDER_SYSTEM = `You write short payment reminders that a freelancer sends through PayPal's invoice reminder.
Return ONLY JSON: {"subject":"","note":""}.
- subject: max 80 characters.
- note: 2-4 sentences, max 600 characters, plain text. Mention the invoice number, the amount still due and the work.
- Tone "friendly": warm, assume they forgot. "firm": clear and direct, ask for a payment date. "final": polite but serious, say this is the last reminder before pausing further work.
- Never threaten legal action, fees or collections. Never invent facts. Do not include links (PayPal adds the pay button).`;

export async function draftReminder(row, { tone, llm, today, sender = 'me' }) {
  const t = TONES[tone] ? tone : toneFor(row.days_overdue);
  const facts = {
    tone: t,
    client: row.recipient.name || row.recipient.business || 'there',
    invoice_number: row.number,
    amount_due: `${row.currency} ${row.due}`,
    already_paid: Number(row.paid) > 0 ? `${row.currency} ${row.paid}` : null,
    work: row.items.map((i) => i.name).join(', '),
    due_date: row.due_date,
    days_overdue: row.days_overdue,
    today,
  };
  if (llm && (await llm.available())) {
    try {
      const out = await llm.chat([
        { role: 'system', content: REMINDER_SYSTEM },
        { role: 'user', content: JSON.stringify(facts) },
      ], { maxTokens: 300, temperature: 0.4 });
      const j = extractJson(out.text);
      if (j?.subject && j?.note) return { tone: t, subject: String(j.subject).slice(0, 80), note: guard(String(j.note)).slice(0, 600), via: 'llm' };
    } catch { /* fall through to template */ }
  }
  return { tone: t, ...templateReminder(facts, sender), via: 'template' };
}

/** Remove anything the model must not say (links, threats) even if the prompt is ignored. */
function guard(note) {
  return note
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^.]*\b(lawyer|legal action|court|collections? agency|late fee)\b[^.]*\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function templateReminder(f, sender = 'me') {
  const paid = f.already_paid ? ` Thank you for the ${f.already_paid} already received.` : '';
  const bodies = {
    friendly: `Hi ${f.client}, just a quick reminder that invoice #${f.invoice_number} for ${f.work} (${f.amount_due}) was due on ${f.due_date}.${paid} You can pay it with the button below. Thanks!`,
    firm: `Hi ${f.client}, invoice #${f.invoice_number} for ${f.work} is now ${f.days_overdue} days past due, with ${f.amount_due} outstanding.${paid} Could you let me know when you expect to pay it?`,
    final: `Hi ${f.client}, this is my last reminder about invoice #${f.invoice_number} (${f.amount_due}), now ${f.days_overdue} days overdue.${paid} Please settle it or reply with a date this week, otherwise I will need to pause further work.`,
  };
  const subjects = {
    friendly: `Reminder: invoice #${f.invoice_number}`,
    firm: `Invoice #${f.invoice_number} is ${f.days_overdue} days overdue`,
    final: `Final reminder: invoice #${f.invoice_number}`,
  };
  return { subject: subjects[f.tone], note: bodies[f.tone] };
}
