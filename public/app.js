// Paid-Up UI. Talks only to this Worker's /api/* (see docs/api.md). No build step.
// Every action that reaches PayPal (create, send, remind, record) needs an explicit click,
// and send / remind / record also need a confirmation tick.

const ag = window.agGrid;
if (ag.ModuleRegistry && ag.AllCommunityModule) ag.ModuleRegistry.registerModules([ag.AllCommunityModule]);

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const money = (v, cur = 'USD') => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '–';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n); } catch { return `${cur} ${n.toFixed(2)}`; }
};

const state = { overview: null, health: null, filter: 'all', selected: null, tones: {} };

// ---------- API ----------
async function api(path, { method = 'GET', body } = {}) {
  const url = method === 'GET' ? `${path}${path.includes('?') ? '&' : '?'}today=${today()}` : path;
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify({ today: today(), ...body }) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (data?.paypal_calls?.length) logCalls(data.paypal_calls, data.paypal_mode);
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

// ---------- activity log ----------
function log(html) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span> ${html}`;
  $('#log').prepend(li);
}
function logCalls(calls, mode) {
  for (const c of calls) {
    log(`<span class="m">PayPal${mode === 'mock' ? ' (mock)' : ''}</span> ${esc(c.method)} ${esc(c.path)} → <span class="s${String(c.status)[0]}">${esc(c.status)}</span>${c.ms != null ? ` · ${esc(c.ms)} ms` : ''}${c.debug_id ? ` · debug_id ${esc(c.debug_id)}` : ''}`);
  }
}

// ---------- header badges ----------
async function loadHealth() {
  try {
    const h = await api('/api/health');
    state.health = h;
    state.tones = h.tones || {};
    const pp = h.paypal?.mode === 'live'
      ? `<span class="badge ok">PayPal ${esc(h.paypal.environment || 'sandbox')}</span>`
      : '<span class="badge warn">PayPal mock (no sandbox keys)</span>';
    const l = h.llm || {};
    const ai = l.mode === 'off' || l.remaining === 0
      ? `<span class="badge warn" title="Daily AI budget used up — rules and templates take over">AI: rules only today</span>`
      : `<span class="badge" title="${esc(l.model || '')}">AI on · ${esc(l.remaining ?? '?')}/${esc(l.cap ?? '?')} calls left today</span>`;
    $('#modes').innerHTML = pp + ai;
  } catch (e) {
    $('#modes').innerHTML = `<span class="badge warn">API unreachable: ${esc(e.message)}</span>`;
  }
}

// ---------- KPIs ----------
function renderKpis(t) {
  for (const el of document.querySelectorAll('[data-k]')) el.textContent = money(t?.[el.dataset.k], t?.currency);
}

// ---------- main grid (AG Grid Community) ----------
const ACTION_LABEL = { send: 'Send', remind: 'Remind', record_payment: 'Record payment', wait: 'Wait', none: '—' };
const ACTION_ICON = { send: '➤', remind: '✉', record_payment: '✓', wait: '⏳', none: '' };

class ActionCell {
  init(p) {
    this.el = document.createElement('span');
    const n = p.data?.next;
    if (!n || p.node.rowPinned) { this.el.textContent = ''; return; }
    const tone = n.action === 'remind' && n.tone ? ` <small>(${esc(state.tones[n.tone]?.label || n.tone)})</small>` : '';
    this.el.innerHTML = `<span class="act ${esc(n.action)}">${ACTION_ICON[n.action] || ''} ${esc(ACTION_LABEL[n.action] || n.action)}${tone}</span>`;
  }
  getGui() { return this.el; }
  refresh() { return false; }
}
class StatusCell {
  init(p) {
    this.el = document.createElement('span');
    if (p.node.rowPinned || !p.value) return;
    this.el.innerHTML = `<span class="pill ${esc(p.value)}">${esc(p.value.replace(/_/g, ' ').toLowerCase())}</span>`;
  }
  getGui() { return this.el; }
  refresh() { return false; }
}
class OverdueCell {
  init(p) {
    this.el = document.createElement('div');
    this.el.className = 'overdue-bar';
    const d = Number(p.value) || 0;
    if (p.node.rowPinned || !d) { this.el.textContent = p.node.rowPinned ? '' : '—'; return; }
    const w = Math.min(100, Math.round((d / 30) * 100));
    this.el.innerHTML = `<i class="${d > 21 ? 'final' : ''}" style="width:${w}px"></i><span>${d} d</span>`;
  }
  getGui() { return this.el; }
  refresh() { return false; }
}
class ButtonCell {
  init(p) {
    this.el = document.createElement('span');
    const n = p.data?.next;
    if (p.node.rowPinned || !n || n.action === 'none' || n.action === 'wait') return;
    const b = document.createElement('button');
    b.className = 'cell-btn';
    b.textContent = n.action === 'record_payment' ? 'Review match' : n.action === 'send' ? 'Review & send' : 'Draft reminder';
    b.addEventListener('click', (ev) => { ev.stopPropagation(); openSide(p.data); });
    this.el.appendChild(b);
  }
  getGui() { return this.el; }
  refresh() { return false; }
}

const columnDefs = [
  { field: 'next.action', headerName: 'Next step', cellRenderer: ActionCell, width: 168, pinned: 'left',
    comparator: (a, b, na, nb) => (na.data?.next?.priority ?? 0) - (nb.data?.next?.priority ?? 0), sort: 'desc',
    tooltipValueGetter: (p) => p.data?.next?.why },
  { field: 'number', headerName: 'Invoice #', width: 92 },
  { headerName: 'Client', valueGetter: (p) => p.data?.recipient ? (p.data.recipient.business || p.data.recipient.name) : '', flex: 1, minWidth: 140,
    tooltipValueGetter: (p) => p.data?.recipient?.email },
  { field: 'status', headerName: 'Status', cellRenderer: StatusCell, width: 120 },
  { field: 'total', headerName: 'Total', type: 'rightAligned', width: 100, valueFormatter: (p) => p.value == null ? '' : money(p.value, p.data?.currency), comparator: (a, b) => Number(a) - Number(b) },
  { field: 'due', headerName: 'Balance', type: 'rightAligned', width: 100, valueFormatter: (p) => p.value == null ? '' : money(p.value, p.data?.currency), comparator: (a, b) => Number(a) - Number(b),
    cellStyle: (p) => (Number(p.value) > 0 && !p.node.rowPinned ? { fontWeight: 600 } : null) },
  { field: 'due_date', headerName: 'Due', width: 104 },
  { field: 'days_overdue', headerName: 'Overdue', cellRenderer: OverdueCell, width: 110, comparator: (a, b) => a - b },
  { headerName: 'Last contact', valueGetter: (p) => (p.data?.last_contact || p.data?.last_sent || '').slice(0, 10), width: 112, hide: window.innerWidth < 1700 },
  { headerName: 'Why', valueGetter: (p) => p.data?.next?.why || '', flex: 1.4, minWidth: 200, tooltipValueGetter: (p) => p.data?.next?.why },
  { colId: 'actions', headerName: '', cellRenderer: ButtonCell, width: 138, sortable: false, pinned: 'right' },
];

const grid = ag.createGrid($('#grid'), {
  columnDefs,
  defaultColDef: { sortable: true, resizable: true },
  rowData: [],
  getRowId: (p) => p.data.id,
  rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
  tooltipShowDelay: 300,
  isExternalFilterPresent: () => state.filter !== 'all',
  doesExternalFilterPass: (node) => {
    const r = node.data;
    if (state.filter === 'action') return ['send', 'remind', 'record_payment'].includes(r.next?.action);
    if (state.filter === 'overdue') return r.days_overdue > 0;
    if (state.filter === 'paid') return ['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL'].includes(r.status);
    return true;
  },
  onRowClicked: (e) => { if (!e.node.rowPinned) openSide(e.data); },
  onFilterChanged: () => updatePinned(),
  getRowStyle: (p) => (p.node.rowPinned ? { fontWeight: 700 } : null),
});

function updatePinned() {
  const rows = [];
  grid.forEachNodeAfterFilter((n) => rows.push(n.data));
  const cur = rows[0]?.currency || 'USD';
  const sum = (f) => rows.reduce((s, r) => s + Number(r[f] || 0), 0).toFixed(2);
  grid.setGridOption('pinnedBottomRowData', [{ id: '__total', number: `${rows.length} shown`, currency: cur, total: sum('total'), due: sum('due') }]);
}

// keepSide: after an action, refresh the grid and KPIs but leave the side panel (and its
// confirmation message) as it is.
async function loadOverview({ select, keepSide = false } = {}) {
  try {
    const o = await api('/api/overview');
    state.overview = o;
    renderKpis(o.totals);
    grid.setGridOption('rowData', o.rows);
    updatePinned();
    renderUnmatched(o.unmatched_payments || []);
    // PayPal's transaction search lags behind; say how far it reaches so a missing recent payment makes sense.
    const fresh = o.transactions_refreshed_at ? new Date(o.transactions_refreshed_at) : null;
    $('#tx-fresh').hidden = !fresh || Number.isNaN(fresh.getTime());
    if (fresh && !Number.isNaN(fresh.getTime())) {
      $('#tx-fresh').textContent = `Payments shown up to ${fresh.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. PayPal's transaction search lags behind, so a payment made after that is not matched yet.`;
    }
    if (o.transaction_search_error) log(`<span class="s4">Transaction Search failed:</span> ${esc(o.transaction_search_error)} — payment matching skipped this time.`);
    if (select) {
      const row = o.rows.find((r) => r.id === select);
      if (row) { grid.getRowNode(row.id)?.setSelected(true); grid.ensureNodeVisible(grid.getRowNode(row.id)); openSide(row); }
    } else if (state.selected && !keepSide) {
      const row = o.rows.find((r) => r.id === state.selected.id);
      if (row) openSide(row); else closeSide();
    }
  } catch (e) {
    log(`<span class="s4">Could not load invoices:</span> ${esc(e.message)}`);
  }
}

function renderUnmatched(list) {
  $('#unmatched').hidden = !list.length;
  $('#unmatched-list').innerHTML = list.map((t) => `<li>${money(t.amount, t.currency)} from <b>${esc(t.payer || t.email || 'unknown')}</b> on ${esc((t.date || '').slice(0, 10))}${t.note ? ` — “${esc(t.note)}”` : ''}</li>`).join('');
}

document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
  state.filter = c.dataset.f;
  grid.onFilterChanged();
}));
$('#quick').addEventListener('input', (e) => { grid.setGridOption('quickFilterText', e.target.value); updatePinned(); });
$('#export').addEventListener('click', () => grid.exportDataAsCsv({
  fileName: `paid-up-${today()}.csv`,
  skipPinnedBottom: true,
  columnKeys: grid.getColumns().map((c) => c.getColId()).filter((id) => id !== 'actions'),
  processCellCallback: (p) => (p.column.getColId() === 'next.action' ? (p.node.data?.next?.action || '') : p.value),
}));
$('#refresh').addEventListener('click', () => loadOverview());

// ---------- side panel: one decision at a time ----------
function closeSide() {
  state.selected = null;
  $('#side').hidden = true;
}
$('#side-close').addEventListener('click', closeSide);

function facts(r) {
  return `<dl class="facts">
    <dt>Invoice</dt><dd>${esc(r.number || r.id)} · <span class="pill ${esc(r.status)}">${esc(r.status.replace(/_/g, ' ').toLowerCase())}</span></dd>
    <dt>Client</dt><dd>${esc(r.recipient.business || r.recipient.name)}${r.recipient.business && r.recipient.name ? ` (${esc(r.recipient.name)})` : ''}<br><small>${esc(r.recipient.email || 'no email')}</small></dd>
    <dt>Total</dt><dd>${money(r.total, r.currency)}${Number(r.paid) > 0 ? ` · paid ${money(r.paid, r.currency)}` : ''}</dd>
    <dt>Balance</dt><dd><b>${money(r.due, r.currency)}</b></dd>
    <dt>Due</dt><dd>${esc(r.due_date || '—')}${r.days_overdue ? ` · <b>${r.days_overdue} days overdue</b>` : ''}</dd>
    <dt>Last contact</dt><dd>${esc((r.last_contact || r.last_sent || '').slice(0, 10) || '—')}${r.last_reminder ? ' <small>(reminder)</small>' : ''}</dd>
  </dl>`;
}

function confirmBox(id, text, button, cls = 'primary') {
  return `<div class="confirm"><label><input type="checkbox" id="${id}-ok"> ${text}</label><button id="${id}" class="${cls}" disabled>${button}</button></div>`;
}
function wireConfirm(id, fn) {
  const ok = $(`#${id}-ok`); const b = $(`#${id}`);
  ok.addEventListener('change', () => { b.disabled = !ok.checked; });
  b.addEventListener('click', async () => {
    b.disabled = true; ok.disabled = true;
    try { await fn(); } catch (e) { $('#side-body').insertAdjacentHTML('beforeend', `<p class="err">${esc(e.message)}</p>`); ok.disabled = false; b.disabled = !ok.checked; }
  });
}

function openSide(r) {
  state.selected = r;
  $('#side').hidden = false;
  const n = r.next || { action: 'none', why: '' };
  $('#side-title').textContent = { send: 'Send this invoice', remind: 'Chase this invoice', record_payment: 'Record a matched payment', wait: 'Nothing to do yet', none: 'Nothing to do' }[n.action] || 'Invoice';
  let html = facts(r) + `<p class="why"><b>Why:</b> ${esc(n.why)}</p>`;

  if (n.action === 'send') {
    html += `<p class="hint">PayPal emails the invoice with a pay link to <b>${esc(r.recipient.email || '(no email — add one first)')}</b>.</p>`;
    html += confirmBox('do-send', `I checked the amount (${money(r.total, r.currency)}) and the client.`, 'Send invoice');
    $('#side-body').innerHTML = html;
    wireConfirm('do-send', async () => {
      const out = await api(`/api/invoices/${encodeURIComponent(r.id)}/send`, { method: 'POST', body: {} });
      $('#side-body').insertAdjacentHTML('beforeend', `<p class="done">Sent. Status is now ${esc(out.invoice.status)}.</p>`);
      log(`You sent ${esc(r.number || r.id)} to ${esc(r.recipient.email)}.`);
      await loadOverview({ keepSide: true });
    });
    return;
  }

  if (n.action === 'remind' || (r.days_overdue > 0 && n.action === 'wait')) {
    const suggested = n.tone || 'friendly';
    const tones = Object.entries(state.tones).map(([k, v]) => `<button data-tone="${esc(k)}" class="${k === suggested ? 'on' : ''}" title="${esc(v.when)}">${esc(v.label)}</button>`).join('');
    html += `<div><div class="lbl">Tone (suggested: ${esc(state.tones[suggested]?.label || suggested)})</div><div class="tones">${tones}</div></div>
      <div id="rem" class="hint">Writing a reminder…</div>`;
    $('#side-body').innerHTML = html;
    const draft = async (tone) => {
      document.querySelectorAll('.tones button').forEach((b) => b.classList.toggle('on', b.dataset.tone === tone));
      $('#rem').innerHTML = 'Writing a reminder…';
      try {
        const out = await api(`/api/invoices/${encodeURIComponent(r.id)}/reminder-draft`, { method: 'POST', body: { tone } });
        const m = out.reminder;
        log(`<span class="ai">AI</span> drafted a ${esc(m.tone)} reminder for ${esc(r.number || r.id)} (${m.via === 'llm' ? 'model' : 'template — AI off or daily budget used up'}).`);
        $('#rem').outerHTML = `<div id="rem" class="draft">
          <label class="lbl" for="rem-subj">Subject</label><input id="rem-subj" value="${esc(m.subject)}">
          <label class="lbl" for="rem-note">Message (edit freely)</label><textarea id="rem-note" rows="8">${esc(m.note)}</textarea>
          <p class="hint">Written by ${m.via === 'llm' ? 'the AI' : 'a template (the AI is off or the daily budget is used up)'}. PayPal sends it with the invoice link.</p>
          ${confirmBox('do-remind', 'I read this message and want PayPal to send it now.', 'Send reminder')}
        </div>`;
        wireConfirm('do-remind', async () => {
          const subject = $('#rem-subj').value.trim(); const note = $('#rem-note').value.trim();
          const res = await api(`/api/invoices/${encodeURIComponent(r.id)}/remind`, { method: 'POST', body: { subject, note } });
          $('#rem').insertAdjacentHTML('beforeend', `<p class="done">Reminder sent. Last contact is now ${esc((res.invoice.last_contact || res.invoice.last_sent || '').slice(0, 10) || 'today')}.</p>`);
          log(`You sent a reminder for ${esc(r.number || r.id)}.`);
          await loadOverview({ keepSide: true });
        });
      } catch (e) { $('#rem').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    };
    document.querySelectorAll('.tones button').forEach((b) => b.addEventListener('click', () => draft(b.dataset.tone)));
    if (n.action === 'remind') draft(suggested); else $('#rem').innerHTML = '<p class="hint">Contacted recently. Pick a tone only if you want to write anyway.</p>';
    return;
  }

  if (n.action === 'record_payment' && r.match) {
    const m = r.match;
    html += `<div class="draft"><h3>Matched payment</h3>
      <dl class="facts"><dt>From</dt><dd>${esc(m.payer)}</dd><dt>Amount</dt><dd>${money(m.amount, m.currency)} (${m.settles === 'full' ? 'settles it' : 'partial'})</dd>
      <dt>Date</dt><dd>${esc((m.date || '').slice(0, 10))}</dd><dt>Transaction</dt><dd><small>${esc(m.tx_id)}</small></dd></dl>
      <div class="lbl">Why Paid-Up thinks it is this invoice</div><ul class="checks">${m.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    html += confirmBox('do-record', `This ${money(m.amount, m.currency)} from ${esc(m.payer)} is for ${esc(r.number || r.id)}.`, 'Record payment at PayPal');
    $('#side-body').innerHTML = html;
    wireConfirm('do-record', async () => {
      const amount = Math.min(Number(m.amount), Number(r.due)).toFixed(2);
      const out = await api(`/api/invoices/${encodeURIComponent(r.id)}/payments`, { method: 'POST', body: { method: 'PAYPAL', amount, payment_date: (m.date || today()).slice(0, 10), tx_id: m.tx_id } });
      $('#side-body').insertAdjacentHTML('beforeend', `<p class="done">Recorded. Status is now ${esc(out.invoice.status.replace(/_/g, ' ').toLowerCase())}.</p>`);
      log(`You recorded ${money(amount, m.currency)} on ${esc(r.number || r.id)} (transaction ${esc(m.tx_id)}).`);
      await loadOverview({ keepSide: true });
    });
    return;
  }

  if (r.payer_url) html += `<p class="hint"><a href="${esc(r.payer_url)}" target="_blank" rel="noopener">Open the invoice as the client sees it</a></p>`;
  $('#side-body').innerHTML = html;
}

// ---------- compose: message -> draft -> PayPal draft ----------
let samples = [];
fetch('/demo/sample-requests.json').then((r) => r.json()).then((j) => {
  samples = j.requests || [];
  $('#sample').insertAdjacentHTML('beforeend', samples.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join(''));
}).catch(() => {});
$('#sample').addEventListener('change', (e) => {
  const s = samples.find((x) => x.id === e.target.value);
  if (s) $('#msg').value = s.text;
});

const itemsGrid = ag.createGrid($('#items-grid'), {
  columnDefs: [
    { field: 'name', headerName: 'Item', editable: true, flex: 1, minWidth: 110 },
    { field: 'quantity', headerName: 'Qty', editable: true, width: 58, type: 'rightAligned', valueParser: (p) => Number(p.newValue) || 1 },
    { field: 'unit_amount', headerName: 'Price', editable: true, width: 76, type: 'rightAligned', valueParser: (p) => Number(String(p.newValue).replace(/[^0-9.]/g, '')) || 0,
      valueFormatter: (p) => Number(p.value).toFixed(2) },
    { headerName: 'Amount', width: 84, type: 'rightAligned', valueGetter: (p) => (Number(p.data.quantity) * Number(p.data.unit_amount)).toFixed(2) },
    { headerName: '', width: 40, cellRenderer: (p) => {
      const b = document.createElement('button'); b.className = 'cell-btn'; b.textContent = '×'; b.title = 'Remove line';
      b.addEventListener('click', () => { itemsGrid.applyTransaction({ remove: [p.data] }); draftTotal(); });
      return b;
    } },
  ],
  rowData: [],
  singleClickEdit: true,
  stopEditingWhenCellsLoseFocus: true,
  onCellValueChanged: () => draftTotal(),
});

function draftItems() { const a = []; itemsGrid.forEachNode((n) => a.push(n.data)); return a; }
function draftTotal() {
  const t = draftItems().reduce((s, it) => s + Number(it.quantity) * Number(it.unit_amount), 0);
  $('#d-total').textContent = money(t, ($('#d-currency').value || 'USD').toUpperCase());
}
$('#d-currency').addEventListener('input', draftTotal);
$('#add-item').addEventListener('click', () => { itemsGrid.applyTransaction({ add: [{ name: 'New item', quantity: 1, unit_amount: 0 }] }); draftTotal(); });

$('#read').addEventListener('click', async () => {
  const text = $('#msg').value.trim();
  if (!text) { $('#msg').focus(); return; }
  const b = $('#read'); b.disabled = true; b.textContent = 'Reading…';
  try {
    const out = await api('/api/draft', { method: 'POST', body: { text } });
    const d = out.draft;
    $('#d-name').value = d.recipient.name; $('#d-business').value = d.recipient.business; $('#d-email').value = d.recipient.email;
    $('#d-currency').value = d.currency; $('#d-due').value = d.due_date || '';
    itemsGrid.setGridOption('rowData', d.items.map((it) => ({ ...it })));
    $('#via').textContent = out.via === 'llm' ? 'read by AI' : 'read by rules (AI off)';
    $('#via').className = `badge ${out.via === 'llm' ? '' : 'warn'}`;
    // A rule-based read (AI unavailable) comes with a field:'reader' check naming what the rules could not apply.
    const reader = out.checks.find((c) => c.field === 'reader');
    $('#reader-warn').hidden = !reader;
    $('#reader-warn').textContent = reader ? reader.reason : '';
    $('#checks').innerHTML = out.checks.filter((c) => c.field !== 'reader').map((c) => `<li class="${c.ok ? '' : 'no'}">${c.ok ? '✓' : '⚠'} <b>${esc(c.field)}</b> ${esc(c.value)} — ${esc(c.reason)}</li>`).join('');
    $('#draft').hidden = false;
    draftTotal();
    const unsure = out.checks.filter((c) => !c.ok).length;
    log(`<span class="ai">AI</span> read the message (${out.via === 'llm' ? 'model' : 'rules'}): ${d.items.length} line(s), ${unsure ? `${unsure} thing(s) to confirm` : 'everything found in the text'}.`);
    for (const t of out.trace || []) log(`<span class="ai">AI</span> ${esc(t.step)}: ${esc(t.note)}`);
    if (out.llm) loadHealth();
  } catch (e) {
    log(`<span class="s4">Could not read the message:</span> ${esc(e.message)}`);
  } finally { b.disabled = false; b.textContent = 'Read it'; }
});

$('#create').addEventListener('click', async () => {
  itemsGrid.stopEditing();
  const draft = {
    recipient: { name: $('#d-name').value.trim(), business: $('#d-business').value.trim(), email: $('#d-email').value.trim() },
    items: draftItems().map((it) => ({ name: String(it.name).trim(), quantity: Number(it.quantity), unit_amount: Number(it.unit_amount) })),
    currency: ($('#d-currency').value || 'USD').toUpperCase(),
    due_date: $('#d-due').value || null,
    note: '',
  };
  const b = $('#create'); b.disabled = true;
  try {
    const out = await api('/api/invoices', { method: 'POST', body: { draft } });
    log(`Draft invoice ${esc(out.invoice.number || out.invoice.id)} created at PayPal for ${money(out.invoice.total, out.invoice.currency)}. Not sent yet.`);
    $('#draft').hidden = true; $('#msg').value = ''; $('#sample').value = '';
    await loadOverview({ select: out.invoice.id });
  } catch (e) {
    log(`<span class="s4">PayPal refused the draft:</span> ${esc(e.message)}`);
  } finally { b.disabled = false; }
});

// ---------- start ----------
loadHealth();
loadOverview();
