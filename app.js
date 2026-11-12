import {
  CURRENCIES, TYPES, toMinor, toPlain, fmt, balances, totalsByCurrency,
  periodRange, periodLabel, periodSummary, accountsIn, txsIn,
  validateTx, validateProject, ensureProjects, normalize, toRemote, mergeRemote, dueItems,
  makeBackup, parseBackup, toCSV, COLS,
} from './core.js';
import { monthlyPdf, accountPdf } from './reports.js';
import { convertOldBackup } from './import-old.js';
import { workbookBytes, parseWorkbook } from './excel.js';
import { loanView } from './loan-bridge.js';
import { overdraftView } from './od-bridge.js';
import { duesNow, advanceViews, fundingViews, budgetViews, planViews, partyViews, cardViews, paymentSplitFor, checkFunding } from './records.js';
import { loanSchedule } from './loan-math.js';
import { toDMY, fromDMY, ALL_RANGE, monthRange, yearRange } from './format.js';
import { ledgerFor } from './records.js';
import { validPin, makePinRecord, checkPin, lockoutLeft, registerFailure } from './security.js';
import { mergeState, duesFile, driveClient, getToken, localState, TABLES } from './drive-sync.js';

const cfg = window.WALLET_CONFIG || {};
const APP = cfg.appName || 'DSi Digital';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const todayStr = () => new Date().toLocaleDateString('en-CA');
const dmy = iso => toDMY(iso);
// Number only, with thousands separators and the currency's own decimals (BHD 3, INR and USD 2).
const grp = (minor, cur) => fmt(minor, cur).replace(/^(−?)[^\d]*/, '$1');
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };

const today = todayStr();
let S = { projects: [], accounts: [], txs: [], loans: [], advances: [], funding: [], parties: [], budgets: [], plans: [], statements: [] };
const RECORD_TABLES = ['advances', 'funding', 'parties', 'budgets', 'plans', 'statements'];
let view = 'home', pid = 'all', search = '';
let period = { mode: 'month', month: today.slice(0, 7), year: today.slice(0, 4), from: `${today.slice(0, 4)}-01-01`, to: today };
let drive = null, token = null, syncing = false, syncTimer = null;
let pendingImport = null, pendingXls = null;

// ---------- Local database (IndexedDB): works offline ----------
const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('dsi-wallet', 4);
  req.onupgradeneeded = () => {
    const db = req.result;
    for (const [name, key] of [['accounts', 'id'], ['transactions', 'id'], ['meta', 'key'], ['projects', 'id'], ['loans', 'id'], ...RECORD_TABLES.map(t => [t, 'id'])]) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: key });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function getAll(store) {
  const db = await dbReady;
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function putMany(store, rows) {
  if (!rows.length) return;
  const db = await dbReady;
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const r of rows) s.put(r);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
}
async function getMeta(key) {
  const db = await dbReady;
  return new Promise((res, rej) => {
    const r = db.transaction('meta').objectStore('meta').get(key);
    r.onsuccess = () => res(r.result?.value); r.onerror = () => rej(r.error);
  });
}
const setMeta = (key, value) => putMany('meta', [{ key, value }]);
async function loadAll() {
  S.projects = await getAll('projects');
  S.accounts = await getAll('accounts');
  S.txs = await getAll('transactions');
  S.loans = await getAll('loans');
  for (const t of RECORD_TABLES) S[t] = await getAll(t);
}
// Every local change is marked dirty so the next sync uploads it.
async function writeRows(store, rows) {
  const now = Date.now();
  await putMany(store, rows.map(r => ({ ...r, updated_at: now, dirty: true })));
  await loadAll();
  scheduleSync();
}
// Gives older data a project book (one per currency) without losing anything.
async function migrate() {
  const noKind = S.accounts.filter(a => !a.deleted && !a.kind).map(a => ({ ...a, kind: 'bank', updated_at: Date.now(), dirty: true }));
  if (noKind.length) { await putMany('accounts', noKind); await loadAll(); }
  const r = ensureProjects(S.projects, S.accounts, { now: Date.now(), newId: () => crypto.randomUUID() });
  if (r.projects.length || r.accounts.length) {
    await putMany('projects', r.projects);
    await putMany('accounts', r.accounts);
    await loadAll();
  }
}

// ---------- Helpers ----------
const liveProjects = () => S.projects.filter(p => !p.deleted).sort((a, b) => a.name.localeCompare(b.name));
const projById = id => S.projects.find(p => p.id === id);
const projName = id => projById(id)?.name || '';
const accById = id => S.accounts.find(a => a.id === id);
const curOf = id => accById(id)?.currency || '';
const liveAccounts = () => S.accounts.filter(a => !a.deleted).sort((a, b) => projName(a.project_id).localeCompare(projName(b.project_id)) || a.name.localeCompare(b.name));
const accLabel = a => `${a.name} · ${projName(a.project_id)} (${a.currency})`;
const dialogOpen = () => ['txDialog', 'accDialog', 'projDialog', 'repDialog', 'impDialog', 'xlsDialog'].some(id => $('#' + id)?.open);
const projectCount = id => S.accounts.filter(a => !a.deleted && a.project_id === id).length;
const pidLabel = () => pid === 'all' ? 'All projects' : projName(pid);
const inPeriod = t => { const r = periodRange(period); return t.date >= r.from && t.date <= r.to; };

function setStatus(msg) {
  $('#status').textContent = msg;
  const s = $('#syncMsg'); if (s) s.textContent = msg;
}

// ---------- Shared controls ----------
function projectSelect() {
  return `<select id="projSel" aria-label="Project">
    <option value="all" ${pid === 'all' ? 'selected' : ''}>All projects</option>
    ${liveProjects().map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)} (${p.currency})</option>`).join('')}
  </select>`;
}

function periodBar() {
  const p = period, y0 = Number(today.slice(0, 4));
  const years = Array.from({ length: 12 }, (_, i) => y0 - 8 + i);
  const bad = p.mode === 'custom' && p.from > p.to ? '<p class="error">"From" must be before "To".</p>' : '';
  return `<div class="period">
    <select id="perMode" aria-label="Date range">
      <option value="month" ${p.mode === 'month' ? 'selected' : ''}>Month</option>
      <option value="year" ${p.mode === 'year' ? 'selected' : ''}>Year</option>
      <option value="custom" ${p.mode === 'custom' ? 'selected' : ''}>Custom dates</option>
      <option value="all" ${p.mode === 'all' ? 'selected' : ''}>All dates</option>
    </select>
    ${p.mode === 'month' ? `<input type="month" id="perMonth" value="${p.month}" aria-label="Month">` : ''}
    ${p.mode === 'year' ? `<select id="perYear" aria-label="Year">${years.map(y => `<option ${String(y) === p.year ? 'selected' : ''}>${y}</option>`).join('')}</select>` : ''}
    ${p.mode === 'custom' ? `<input type="text" id="perFrom" value="${toDMY(p.from)}" placeholder="DD-MM-YYYY" aria-label="From date"><input type="text" id="perTo" value="${toDMY(p.to)}" placeholder="DD-MM-YYYY" aria-label="To date">` : ''}
  </div>${bad}`;
}

// ---------- Views ----------
function render() {
  if (pid !== 'all' && !liveProjects().some(p => p.id === pid)) pid = 'all';
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#fab').hidden = view === 'more' || view === 'accounts';
  const views = { home: homeView, txs: txView, accounts: accountsView, more: moreView };
  $('#main').innerHTML = views[view]();
}

function txRow(t) {
  const a = accById(t.account_id), to = accById(t.to_account_id);
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '⇄';
  const title = t.type === 'transfer'
    ? `${esc(a?.name)} → ${esc(to?.name)}`
    : esc(t.category || (t.type === 'income' ? 'Income' : 'Expense'));
  const sub = [toDMY(t.date), t.note && esc(t.note), t.type !== 'transfer' && esc(a?.name), esc(projName(a?.project_id))].filter(Boolean).join(' · ');
  return `<button class="row tx ${t.type}" data-act="edit-tx" data-id="${t.id}">
    <div><b>${title}</b><small>${sub}</small></div>
    <span>${sign}${fmt(t.amount, a?.currency)}</span></button>`;
}

function homeView() {
  const bal = balances(S.accounts, S.txs);
  const tot = totalsByCurrency(accountsIn(S.accounts, pid), bal);
  const r = periodRange(period);
  const sum = periodSummary(S.txs, S.accounts, r.from, r.to, pid);
  const totals = Object.entries(tot).map(([c, v]) => `<div class="stat"><span>${esc(pidLabel())} · ${c}</span><b>${fmt(v, c)}</b></div>`).join('')
    || '<p class="muted">No accounts here yet. Go to Accounts → + Add.</p>';
  const rows = Object.entries(sum).map(([c, v]) =>
    `<div class="row"><b>${c}</b><span><span class="in">+${fmt(v.income, c)}</span> &nbsp; <span class="out">−${fmt(v.expense, c)}</span></span></div>`).join('')
    || '<p class="muted">No income or expenses in this period.</p>';
  const recent = txsIn(S.txs, S.accounts, pid).filter(t => !t.deleted && inPeriod(t))
    .sort((a, b) => b.date.localeCompare(a.date) || b.updated_at - a.updated_at).slice(0, 8);
  const dues = duesNow(S, today, 14, pid);
  const kindLabel = { loan: 'Loan instalments', card: 'Card statement' };
  // One line per loan or card, so many missed instalments do not fill the screen.
  const groups = new Map();
  for (const d of dues) {
    const key = d.kind + '|' + d.ref;
    const g = groups.get(key) || { name: d.name, kind: d.kind, currency: d.currency, count: 0, overdue: 0, total: 0, next: null, first: d.date };
    g.count++; g.total += d.amount;
    if (d.overdue) g.overdue++;
    else if (!g.next) g.next = d;
    groups.set(key, g);
  }
  const duesHtml = groups.size ? `<section><h2>Payments due soon</h2>${[...groups.values()].map(g => `
    <div class="row due"><div><b>${esc(g.name)}</b><small>${kindLabel[g.kind] || 'Payment'}${g.overdue ? ' · ' + g.overdue + ' overdue (from ' + toDMY(g.first) + ')' : ''}${g.next ? ' · next ' + toDMY(g.next.date) + (g.next.days === 0 ? ' (today)' : ' in ' + g.next.days + ' day(s)') : ''}</small></div>
    <span class="out">${fmt(g.total, g.currency)}</span></div>`).join('')}</section>` : '';
  return `
    <div class="toolbar">${projectSelect()}</div>
    ${duesHtml}
    ${periodBar()}
    <section><h2>Current balance</h2><div class="stats">${totals}</div></section>
    <section><h2>${esc(periodLabel(period))}</h2>${rows}</section>
    <section><h2>Recent</h2>${recent.map(txRow).join('') || '<p class="muted">No transactions in this period.</p>'}</section>`;
}

function txListHtml() {
  const q = search.trim().toLowerCase();
  const list = txsIn(S.txs, S.accounts, pid).filter(t => !t.deleted && inPeriod(t) &&
    (!q || `${t.category} ${t.note}`.toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.updated_at - a.updated_at);
  if (!list.length) return '<p class="muted">No transactions for this period.</p>';
  let html = '', last = '';
  for (const t of list) {
    if (t.date !== last) {
      last = t.date;
      html += `<h3>${toDMY(t.date)}</h3>`;
    }
    html += txRow(t);
  }
  return html;
}

function txView() {
  return `
    <div class="toolbar">${projectSelect()}</div>
    ${periodBar()}
    <section>
      <input id="search" type="search" placeholder="Search category or note" value="${esc(search)}">
    </section>
    <section id="txList">${txListHtml()}</section>`;
}

function accountsView() {
  const bal = balances(S.accounts, S.txs);
  const rows = accountsIn(S.accounts, pid).sort((a, b) => projName(a.project_id).localeCompare(projName(b.project_id)) || a.name.localeCompare(b.name)).map(a => `
    <button class="row" data-act="edit-acc" data-id="${a.id}">
      <div><b>${esc(a.name)}</b><small>${esc(projName(a.project_id))} · ${a.currency}${a.kind === 'card' ? ' · credit card' : ''}</small></div>
      <span>${a.kind === 'card' ? 'Owed ' + fmt(-(bal.get(a.id) || 0), a.currency) : fmt(bal.get(a.id), a.currency)}</span></button>`).join('');
  const odRows = accountsIn(S.accounts, pid).filter(a => a.od || a.kind === 'od').map(a => {
    const v = overdraftView(a, S.projects, S.accounts, S.txs, today);
    return `<button class="row" data-act="open-od" data-id="${a.id}"><div><b>${esc(a.name)}</b><small>Limit ${fmt(a.od?.limit ?? 0, a.currency)} · rate ${a.od?.rate ?? '-'}% · used ${fmt(v.used, a.currency)}</small></div>
      <span>Interest ${fmt(v.interest, a.currency)}</span></button>`;
  }).join('');
  const loanRows = S.loans.filter(l => !l.deleted && (pid === 'all' || l.project === pid)).map(l => {
    const cur = projById(l.project)?.currency;
    const v = loanView(l, S.projects, S.txs, today);
    const next = v.remainingFirst;
    return `<button class="row" data-act="open-loan" data-id="${l.id}">
      <div><b>${esc(l.name)}</b><small>${esc(projName(l.project))} · ${l.mode === 'emi' ? 'EMI ' + fmt(l.emi, cur) : 'no fixed schedule'}${next ? ' · next ' + next.date : ''}</small></div>
      <span>${v.principal == null ? '' : fmt(v.principal, cur)}</span></button>`;
  }).join('');
  return `
    <div class="toolbar">${projectSelect()}</div>
    <section>
      <div class="toolbar"><h2>Accounts</h2><button class="primary" data-act="new-acc">+ Add</button></div>
      ${rows || '<p class="muted">No accounts here yet. Add a bank account, cash wallet or savings account.</p>'}
    </section>
    ${odRows ? `<section><h2>Overdrafts</h2>${odRows}</section>` : ''}
    ${loanRows ? `<section><h2>Loans</h2>${loanRows}</section>` : ''}`;
}

function driveState() {
  if (!driveReady()) return 'Not set up yet. See README, section 2. The app works fully on this device without it.';
  if (!token) return 'Not connected. Connect to keep your phone and PC in step.';
  return tokenValid() ? 'Connected. Changes sync automatically.' : 'Connected, but the sign-in has expired. Tap Sync now.';
}

function moreView() {
  const projects = liveProjects().map(p => `
    <button class="row" data-act="edit-proj" data-id="${p.id}">
      <div><b>${esc(p.name)}</b><small>${p.currency} · ${projectCount(p.id)} account(s)</small></div><span>›</span></button>`).join('');
  return `
    <section>
      <h2>Projects</h2>
      <p class="muted">Each project is a separate book with its own currency and accounts, for example Bahrain or India.</p>
      ${projects || '<p class="muted">No projects yet.</p>'}
      <button class="primary" data-act="new-proj">+ Add project</button>
    </section>
    <section>
      <h2>Records</h2>
      <p class="muted">Parties, budgets, investment plans, advances and loans given or taken, construction funding and card statements.</p>
      <div class="actions wrap">
        ${Object.entries(REC).map(([k, r]) => `<button class="ghost" data-act="rec-list" data-type="${k}">${esc(r.title)}</button>`).join('')}
      </div>
    </section>
    <section>
      <h2>Security</h2>
      <p class="muted">${pinRec ? 'A PIN is set on this device. The app asks for it when it opens and after a minute away.' : 'No PIN is set. Anyone with this device can open the app.'}</p>
      <div class="actions wrap">${pinRec
        ? '<button class="ghost" data-act="pin-change">Change PIN</button><button class="ghost" data-act="pin-remove">Remove PIN</button>'
        : '<button class="primary" data-act="pin-set">Set a PIN</button>'}</div>
      <p class="muted">The PIN locks the app screen on this device. It does not encrypt your data.</p>
    </section>
    <section>
      <h2>Payment reminders</h2>
      <p class="muted">Get a notification on this PC or phone when a payment is due, even when the app is closed. You can also get the same reminders on WhatsApp (README, section 13).</p>
      <div class="actions wrap">
        <button class="primary" data-act="rem-desktop">Turn on reminders on this device</button>
        <button class="ghost" data-act="rem-test">Send a test notification</button>
      </div>
      <p id="remMsg" class="muted"></p>
    </section>
    <section>
      <h2>Google Drive</h2>
      <p id="syncMsg" class="muted">${driveState()}</p>
      <div class="actions wrap">
        ${token ? '<button class="primary" data-act="sync-now">Sync now</button>' : '<button class="primary" data-act="drive-connect">Connect Google Drive</button>'}
      </div>
      <p class="muted">Your data is kept in the app's private Drive folder. Payment reminders are explained in README, section 13.</p>
    </section>
    <section>
      <h2>Reports</h2>
      <p class="muted">Printable PDF statements: a whole month, or one account over any date range.</p>
      <button class="primary" data-act="reports">Create PDF report</button>
    </section>
    <section>
      <h2>Excel</h2>
      <p class="muted">Export all projects, accounts and transactions to Excel, or add and change data by importing a file. Nothing is saved until every row checks out.</p>
      <div class="actions wrap">
        <button class="primary" data-act="xls-export">Export to Excel</button>
        <button class="ghost" data-act="xls-template">Blank template</button>
        <button class="ghost" data-act="xls-import">Import from Excel</button>
        <input type="file" id="xlsFile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
      </div>
    </section>
    <section>
      <h2>Old DSi Finance data</h2>
      <p class="muted">Bring in projects, accounts and transactions from a backup file of the old DSi Finance App. You will see a preview before anything is saved.</p>
      <button class="ghost" data-act="import-old">Import old app backup</button>
      <input type="file" id="oldFile" accept="application/json,.json" hidden>
    </section>
    <section>
      <h2>Backup</h2>
      <p class="muted">Save everything to a file you keep safely, for example in your Google Drive or OneDrive. Restore it on any device.</p>
      <div class="actions wrap">
        <button class="primary" data-act="export-json">Export backup</button>
        <button class="ghost" data-act="export-csv">Export CSV (transactions)</button>
        <button class="ghost" data-act="restore">Restore backup</button>
        <input type="file" id="restoreFile" accept="application/json,.json" hidden>
      </div>
    </section>
    <section>
      <h2>About</h2>
      <p class="about"><b>DSi Digital</b><br>Code | Content | Commerce</p>
      <p class="about"><span>Smart Software</span><span>Educational Media</span><span>Accounting Tools</span></p>
      <p class="muted">${esc(APP)} · version 2.1</p>
    </section>`;
}

// ---------- Transaction form ----------
function accOptions(sel, onlyCur = null) {
  return liveAccounts().filter(a => !onlyCur || a.currency === onlyCur)
    .map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(accLabel(a))}</option>`).join('');
}

function fillCategories() {
  const set = [...new Set(S.txs.filter(t => !t.deleted && t.category).map(t => t.category))].sort();
  $('#catList').innerHTML = set.map(c => `<option value="${esc(c)}">`).join('');
}

function updateTxForm(preferTo) {
  const f = $('#txForm'), type = f.elements.type.value, from = f.elements.account_id.value, cur = curOf(from);
  const isTransfer = type === 'transfer';
  $('#toWrap').hidden = !isTransfer;
  $('#txCurrency').textContent = cur;
  const projId = accById(from)?.project_id;
  const proj = S.projects.find(p => p.id === projId);
  const money = type !== 'transfer';
  $('#partyWrap').hidden = !money;
  $('#advWrap').hidden = !money;
  $('#planWrap').hidden = type !== 'expense';
  const toAcc = accById(f.elements.to_account_id.value);
  $('#stmtWrap').hidden = !(isTransfer && toAcc?.kind === 'card');
  const sel = (el, items, none) => { const cur0 = el.value; el.innerHTML = `<option value="">${none}</option>` + items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(''); el.value = cur0; };
  sel(f.elements.party_id, S.parties.filter(p => !p.deleted && p.currency === cur).map(p => [p.id, p.name]), 'No party');
  sel(f.elements.advance_id, S.advances.filter(x => !x.deleted && x.project === projId).map(x => [x.id, x.name + ' (' + x.kind + ')']), 'No advance or loan');
  sel(f.elements.plan_id, S.plans.filter(x => !x.deleted && x.project === projId).map(x => [x.id, x.name]), 'No investment plan');
  sel(f.elements.statement_id, S.statements.filter(x => !x.deleted && toAcc && x.card === toAcc.id).map(x => [x.id, 'Statement ' + toDMY(x.statementDate) + ' · due ' + toDMY(x.dueDate) + ' · ' + x.amount]), 'Not paying a statement');
  void proj;
  if (isTransfer) {
    const options = liveAccounts().filter(a => a.currency === cur && a.id !== from);
    f.elements.to_account_id.innerHTML = options.length
      ? options.map(a => `<option value="${a.id}" ${a.id === preferTo ? 'selected' : ''}>${esc(accLabel(a))}</option>`).join('')
      : `<option value="">No other ${cur} account</option>`;
  }
}

function openTx(t = null, type = 'expense') {
  const f = $('#txForm');
  f.reset();
  f.dataset.id = t?.id || '';
  $('#txTitle').textContent = t ? 'Edit transaction' : 'New transaction';
  $('#txDelete').hidden = !t;
  f.elements.type.value = t?.type || type;
  const first = pid !== 'all' ? liveAccounts().find(a => a.project_id === pid) : liveAccounts()[0];
  f.elements.account_id.innerHTML = accOptions(t?.account_id || first?.id);
  f.elements.date.value = toDMY(t?.date || todayStr());
  f.elements.amount.value = t ? toPlain(t.amount, curOf(t.account_id)) : '';
  f.elements.category.value = t?.category || '';
  f.elements.note.value = t?.note || '';
  fillCategories();
  updateTxForm(t?.to_account_id);
  f.elements.party_id.value = t?.party_id || '';
  f.elements.advance_id.value = t?.advance_id || '';
  f.elements.plan_id.value = t?.plan_id || '';
  f.elements.statement_id.value = t?.pay_kind === 'card' ? t.pay_ref || '' : '';
  $('#txError').textContent = '';
  $('#txDialog').showModal();
  f.elements.amount.focus();
}

async function saveTx(e) {
  e.preventDefault();
  const f = $('#txForm');
  try {
    const type = f.elements.type.value, from = f.elements.account_id.value;
    const prev = S.txs.find(x => x.id === f.dataset.id) || {};
    const fromAcc = accById(from);
    const to = type === 'transfer' ? accById(f.elements.to_account_id.value) : null;
    const amount = toMinor(f.elements.amount.value, curOf(from));
    const advance_id = type !== 'transfer' && f.elements.advance_id.value || null;
    const plan_id = type === 'expense' && f.elements.plan_id.value || null;
    const statementId = type === 'transfer' && f.elements.statement_id.value || '';
    const st = statementId ? S.statements.find(x => x.id === statementId) : null;
    let source_type = type === 'income' ? 'Income' : type === 'expense' ? 'Expense' : (to && to.project_id !== fromAcc.project_id ? 'Transfer' : 'Contra');
    if (advance_id) source_type = type === 'expense' ? 'Advance paid' : 'Advance received';
    else if (plan_id) source_type = 'Investment';
    if (st) source_type = 'Card payment';
    const t = {
      ...prev,
      id: f.dataset.id || crypto.randomUUID(),
      type,
      date: fromDMY(f.elements.date.value),
      amount,
      account_id: from,
      to_account_id: to ? to.id : null,
      category: type === 'transfer' ? '' : f.elements.category.value.trim(),
      note: f.elements.note.value.trim(),
      party_id: type !== 'transfer' && f.elements.party_id.value || null,
      advance_id, plan_id,
      source_type: prev.loan_id ? prev.source_type : source_type,
      project_id: fromAcc.project_id,
      pay_kind: st ? 'card' : (prev.pay_kind || null),
      pay_ref: st ? st.id : (prev.pay_kind === 'card' ? prev.pay_ref : prev.pay_ref || null),
      due_date: st ? st.dueDate : prev.due_date || null,
      principal: st ? amount : (prev.principal ?? null), interest: st ? 0 : (prev.interest ?? null),
      deleted: false,
    };
    validateTx(t, S.accounts);
    await writeRows('transactions', [t]);
    $('#txDialog').close();
    render();
  } catch (err) {
    $('#txError').textContent = err.message;
  }
}

async function deleteTx() {
  const t = S.txs.find(x => x.id === $('#txForm').dataset.id);
  if (!t || !confirm('Delete this transaction? It will be removed from all your devices.')) return;
  await writeRows('transactions', [{ ...t, deleted: true }]);
  $('#txDialog').close();
  render();
}

// ---------- Account form ----------
function openAcc(a = null) {
  const f = $('#accForm');
  f.reset();
  f.dataset.id = a?.id || '';
  $('#accTitle').textContent = a ? 'Edit account' : 'New account';
  f.elements.name.value = a?.name || '';
  const projects = liveProjects();
  // An account keeps its currency, so editing only offers projects in the same currency.
  const offered = a ? projects.filter(p => p.currency === a.currency) : projects;
  const defaultPid = a?.project_id || (pid !== 'all' ? pid : offered[0]?.id);
  f.elements.project_id.innerHTML = offered.map(p => `<option value="${p.id}" ${p.id === defaultPid ? 'selected' : ''}>${esc(p.name)} (${p.currency})</option>`).join('');
  const cur = (offered.find(p => p.id === f.elements.project_id.value) || offered[0])?.currency || '';
  $('#accCur').textContent = cur;
  f.elements.opening.value = a ? toPlain(a.opening, a.currency) : '';
  f.elements.kind.value = a?.kind || 'bank';
  f.elements.statement_day.value = a?.statement_day || '';
  f.elements.due_day.value = a?.due_day || '';
  f.elements.credit_limit.value = a?.credit_limit != null ? toPlain(a.credit_limit, a.currency) : '';
  f.elements.od_limit.value = a?.od ? toPlain(a.od.limit, a.currency) : '';
  f.elements.od_rate.value = a?.od?.rate ?? '';
  f.elements.od_start.value = a?.od?.start ? toDMY(a.od.start) : '';
  toggleCardFields();
  const hasTx = a && S.txs.some(t => !t.deleted && (t.account_id === a.id || t.to_account_id === a.id));
  $('#accHint').textContent = hasTx
    ? 'This account has transactions. Its currency cannot change.'
    : 'Opening balance is what the account held on its start date. Use a minus sign for an overdraft, e.g. -250.';
  $('#accDelete').hidden = !a;
  $('#accError').textContent = '';
  if (!projects.length) $('#accError').textContent = 'Add a project first (More → Projects).';
  $('#accDialog').showModal();
}

function toggleCardFields() {
  const kind = $('#accForm').elements.kind.value;
  $('#cardWrap').hidden = kind !== 'card';
  $('#limitWrap').hidden = kind !== 'card';
  $('#odWrap').hidden = kind !== 'od';
  $('#odStartWrap').hidden = kind !== 'od';
}

const dayOrNull = (v, label) => {
  const t = String(v ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error(`${label} must be a day from 1 to 31`);
  return n;
};

function odFromForm(f, cur) {
  const limit = f.elements.od_limit.value.trim(), rate = Number(f.elements.od_rate.value), start = f.elements.od_start.value;
  if (!limit) throw new Error('Enter the overdraft limit');
  if (!(rate > 0)) throw new Error('Enter the interest rate a year, for example 9.75');
  if (!start) throw new Error('Choose the overdraft start date');
  return { limit: toMinor(limit, cur), rate, basis: 365, start: fromDMY(start) };
}

async function saveAcc(e) {
  e.preventDefault();
  const f = $('#accForm');
  try {
    const name = f.elements.name.value.trim();
    if (!name) throw new Error('Enter an account name');
    const project = projById(f.elements.project_id.value);
    if (!project || project.deleted) throw new Error('Choose a project');
    const id = f.dataset.id || crypto.randomUUID();
    if (liveAccounts().some(a => a.id !== id && a.name.toLowerCase() === name.toLowerCase() && a.project_id === project.id))
      throw new Error('An account with this name already exists in this project');
    const kind = f.elements.kind.value;
    const isCard = kind === 'card';
    const a = {
      id, project_id: project.id, name, currency: project.currency,
      opening: toMinor(f.elements.opening.value || '0', project.currency, true),
      kind,
      statement_day: isCard ? dayOrNull(f.elements.statement_day.value, 'Statement day') : null,
      due_day: isCard ? dayOrNull(f.elements.due_day.value, 'Payment due day') : null,
      credit_limit: isCard && f.elements.credit_limit.value.trim() ? toMinor(f.elements.credit_limit.value, project.currency) : null,
      od: kind === 'od' ? odFromForm(f, project.currency) : null,
      deleted: false,
    };
    await writeRows('accounts', [a]);
    $('#accDialog').close();
    render();
  } catch (err) {
    $('#accError').textContent = err.message;
  }
}

async function deleteAcc() {
  const id = $('#accForm').dataset.id;
  const a = accById(id);
  if (!a) return;
  if (S.txs.some(t => !t.deleted && (t.account_id === id || t.to_account_id === id))) {
    $('#accError').textContent = 'This account has transactions. Delete those first.';
    return;
  }
  if (!confirm(`Delete account "${a.name}"?`)) return;
  await writeRows('accounts', [{ ...a, deleted: true }]);
  $('#accDialog').close();
  render();
}

// ---------- Overdraft detail ----------
function openOd(id) {
  const acc = accById(id);
  if (!acc || !acc.od) return;
  const cur = acc.currency, d = CURRENCIES[cur];
  const v = overdraftView(acc, S.projects, S.accounts, S.txs, today);
  const money = x => grp(Math.round(x * 10 ** d), cur);
  const rows = v.segments.map(s => `<tr><td>${toDMY(s.from)}</td><td>${toDMY(s.to)}</td><td class="num">${s.days}</td><td class="num">${money(s.used)}</td><td class="num">${money(s.interest)}</td></tr>`).join('');
  $('#recBody').innerHTML = `
    <h2>${esc(acc.name)}</h2>
    <p class="muted">${esc(projName(acc.project_id))} · ${cur} · rate ${acc.od.rate}% a year · from ${toDMY(acc.od.start)}</p>
    <div class="stats">
      <div class="stat"><span>Limit</span><b>${fmt(acc.od.limit, cur)}</b></div>
      <div class="stat"><span>Used today</span><b>${fmt(v.used, cur)}</b></div>
      <div class="stat"><span>Available</span><b>${fmt(v.available, cur)}</b></div>
      <div class="stat"><span>Interest charged</span><b>${fmt(v.interest, cur)}</b></div>
    </div>
    <h3>Interest by period</h3>
    ${rows ? `<div class="ledger-table"><table class="tbl"><thead><tr><th>From</th><th>To</th><th class="num">Days</th><th class="num">Used</th><th class="num">Interest</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted">No overdraft periods yet.</p>'}
    <p class="muted">Interest uses the old DSi Finance App's rules, on a 365-day year.</p>
    <div class="actions"><span class="grow"></span><button class="ghost" data-rec-close>Close</button></div>`;
  $('#recDialog').dataset.type = 'od';
  $('#recDialog').showModal();
}

// ---------- Ledger: every movement of one record, with a date range ----------
const LEDGER_PRESETS = [['month', 'This month'], ['year', 'This year'], ['custom', 'Custom'], ['all', 'All dates']];
let ledgerState = null;

function ledgerRange() {
  const st = ledgerState;
  if (st.preset === 'month') return monthRange(today.slice(0, 7));
  if (st.preset === 'year') return yearRange(today.slice(0, 4));
  if (st.preset === 'all') return ALL_RANGE;
  return { from: st.from, to: st.to };
}

function openLedger(type, id) {
  ledgerState = { type, id, preset: 'year', from: `${today.slice(0, 4)}-01-01`, to: today, err: '' };
  renderLedger();
  $('#recDialog').dataset.type = type;
  $('#recDialog').showModal();
}

function renderLedger() {
  const st = ledgerState;
  const L = ledgerFor(S, st.type, st.id, ledgerRange());
  const dis = x => grp(x, L?.currency || 'BHD');
  const head = L ? `${esc(L.title)} · ${L.currency}` : 'Record not found';
  const bodyRows = L ? L.rows.map(r => `<tr><td>${toDMY(r.date)}</td><td>${esc(r.desc)}</td><td class="num">${r.debit ? dis(r.debit) : ''}</td><td class="num">${r.credit ? dis(r.credit) : ''}</td><td class="num">${dis(r.balance)}</td></tr>`).join('') : '';
  $('#recBody').innerHTML = `
    <div class="actions"><button class="ghost" data-rec-list="${st.type}">Back</button></div>
    <h2>Ledger · ${head}</h2>
    <p class="muted">${st.type === 'funding' ? 'Balance shows what is still to come.' : st.type === 'budget' ? 'Balance shows what is left of the budget.' : 'Balance is the running total.'}</p>
    <div class="ledger-controls">
      ${LEDGER_PRESETS.map(([k, l]) => `<button data-led-preset="${k}" class="${st.preset === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    <div class="ledger-controls">
      <input type="text" id="led-from" value="${toDMY(st.from)}" placeholder="DD-MM-YYYY" aria-label="From date" ${st.preset === 'custom' ? '' : 'disabled'}>
      <input type="text" id="led-to" value="${toDMY(st.to)}" placeholder="DD-MM-YYYY" aria-label="To date" ${st.preset === 'custom' ? '' : 'disabled'}>
    </div>
    <p id="led-err" class="error" role="alert">${esc(st.err)}</p>
    ${L ? `<p class="muted">Balance brought forward: <b>${dis(L.opening)}</b></p>
    <div class="ledger-table"><table class="tbl"><thead><tr><th>Date</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
      <tbody>${bodyRows || '<tr><td colspan="5" class="muted">No movements in this period.</td></tr>'}</tbody>
      <tfoot><tr><th colspan="2">Totals for the period</th><th class="num">${dis(L.totals.debit)}</th><th class="num">${dis(L.totals.credit)}</th><th class="num">${dis(L.closing)}</th></tr></tfoot></table></div>`
      : ''}`;
}

document.addEventListener('click', e => {
  const t = e.target;
  if (t.dataset.ledPreset) { ledgerState.preset = t.dataset.ledPreset; ledgerState.err = ''; renderLedger(); return; }
  if (t.dataset.recClose !== undefined) return $('#recDialog').close();
});
document.addEventListener('change', e => {
  if (!ledgerState || (e.target.id !== 'led-from' && e.target.id !== 'led-to')) return;
  try {
    ledgerState[e.target.id === 'led-from' ? 'from' : 'to'] = fromDMY(e.target.value);
    ledgerState.err = '';
  } catch (err) { ledgerState.err = err.message; }
  renderLedger();
});

// ---------- Loan detail ----------
function loanPayForm(l, cur, v) {
  const next = v.remaining[0];
  if (!next) return '';
  const accounts = liveAccounts().filter(a => a.project_id === l.project && (a.kind === 'bank' || a.kind === 'cash' || a.kind === 'other'));
  if (!accounts.length) return '<p class="muted">Add a bank or cash account in this project to record payments.</p>';
  const due = Math.round(next.payment * 10 ** CURRENCIES[cur]);
  return `<form id="loanPayForm" class="stack">
    <h3>Record a payment</h3>
    <label>Instalment due<select name="due">${v.remaining.slice(0, 24).map(r => `<option value="${r.date}">${toDMY(r.date)} · ${toPlain(Math.round(r.payment * 10 ** CURRENCIES[cur]), cur)}</option>`).join('')}</select></label>
    <label>Amount paid <span class="cur">${cur}</span><input name="amount" inputmode="decimal" value="${toPlain(due, cur)}" required></label>
    <label>Paid from<select name="account_id">${accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
    <label>Date<input type="text" name="date" value="${toDMY(today)}" placeholder="DD-MM-YYYY" required></label>
    <p id="loanPayError" class="error" role="alert"></p>
    <div class="actions"><span class="grow"></span><button class="primary">Save payment</button></div>
  </form>`;
}

document.addEventListener('submit', async e => {
  if (e.target.id !== 'loanPayForm') return;
  e.preventDefault();
  const f = e.target, loanId = $('#loanDialog').dataset.id;
  try {
    const l = S.loans.find(x => x.id === loanId);
    const cur = projById(l.project)?.currency;
    const amount = toMinor(f.elements.amount.value, cur);
    const split = paymentSplitFor(S, loanId, f.elements.due.value, amount);
    const acc = accById(f.elements.account_id.value);
    const t = {
      id: crypto.randomUUID(), type: 'expense', date: fromDMY(f.elements.date.value), amount, account_id: acc.id, to_account_id: null,
      category: 'Loan repayment', note: l.name, party_id: null, advance_id: null, plan_id: null,
      source_type: 'Loan repayment', project_id: l.project, loan_id: l.id, adjustment: false,
      principal: split.principal, interest: split.interest, due_date: f.elements.due.value,
      pay_kind: 'loan', pay_ref: l.id, fee: 0, received: null, deleted: false,
    };
    validateTx(t, S.accounts);
    await writeRows('transactions', [t]);
    openLoan(loanId);
    setStatus(`Payment saved: interest ${toPlain(split.interest, cur)}, principal ${toPlain(split.principal, cur)}.`);
  } catch (err) {
    f.querySelector('#loanPayError').textContent = err.message;
  }
});
function openLoan(id) {
  const l = S.loans.find(x => x.id === id);
  if (!l) return;
  $('#loanDialog').dataset.id = id;
  const cur = projById(l.project)?.currency;
  const v = loanView(l, S.projects, S.txs, today);
  const d = CURRENCIES[cur];
  const paidDates = new Set(S.txs.filter(t => !t.deleted && t.loan_id === id && t.due_date).map(t => t.due_date));
  const status = r => paidDates.has(r.date) ? ['Paid', 'status-paid'] : (r.date < today ? ['Overdue', 'status-overdue'] : ['Upcoming', 'status-up']);
  const money = x => grp(Math.round(x * 10 ** d), cur);
  const rows = v.schedule.map(r => { const [label, cls] = status(r); return `<tr><td>${toDMY(r.date)}</td><td class="num">${money(r.payment)}</td><td class="num">${money(r.interest)}</td><td class="num">${money(r.principal)}</td><td class="num">${money(r.closing)}</td><td class="${cls}">${label}</td></tr>`; }).join('');
  $('#loanBody').innerHTML = `
    <p class="muted">${esc(projName(l.project))} · ${cur} · ${l.mode === 'emi' ? 'EMI ' + fmt(l.emi, cur) : 'no fixed schedule'}</p>
    <div class="stats">
      <div class="stat"><span>Outstanding principal</span><b>${v.principal == null ? '-' : fmt(v.principal, cur)}</b></div>
      <div class="stat"><span>Interest accrued to today</span><b>${v.accrued == null ? '-' : fmt(v.accrued, cur)}</b></div>
      <div class="stat"><span>Interest paid so far</span><b>${fmt(v.paidInterest, cur)}</b></div>
      <div class="stat"><span>Interest not yet paid</span><b>${v.unpaidInterest == null ? '-' : fmt(v.unpaidInterest, cur)}</b></div>
    </div>
    ${v.reason ? `<p class="error">${esc(v.reason)}</p>` : ''}
    <h3>EMI schedule</h3>
    ${v.schedule.length ? `<div class="ledger-table"><table class="tbl"><thead><tr><th>Due</th><th class="num">EMI</th><th class="num">Interest</th><th class="num">Principal</th><th class="num">Balance after</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="muted">No fixed schedule for this loan.</p>'}
    ${loanPayForm(l, cur, v)}`;
  $('#loanDialog').showModal();
}
$('#loanClose').onclick = () => $('#loanDialog').close();

// ---------- Records: parties, budgets, plans, advances, funding, card statements ----------
const REC = {
  party: { store: 'parties', title: 'Parties', label: 'Party', fields: [{ k: 'name', l: 'Name', t: 'text' }, { k: 'currency', l: 'Currency', t: 'cur' }] },
  budget: { store: 'budgets', title: 'Budget lines', label: 'Budget line', fields: [{ k: 'project', l: 'Project', t: 'project' }, { k: 'division', l: 'Division', t: 'text' }, { k: 'amount', l: 'Planned amount', t: 'money' }] },
  plan: { store: 'plans', title: 'Investment plans', label: 'Plan', fields: [{ k: 'project', l: 'Project', t: 'project' }, { k: 'name', l: 'Name', t: 'text' }, { k: 'kind', l: 'Kind', t: 'text' }, { k: 'target', l: 'Target', t: 'money' }, { k: 'day', l: 'Day of month', t: 'number' }, { k: 'current', l: 'Current value', t: 'money' }] },
  advance: { store: 'advances', title: 'Advances and loans given or taken', label: 'Advance or loan', fields: [{ k: 'project', l: 'Project', t: 'project' }, { k: 'name', l: 'Person or reference', t: 'text' }, { k: 'kind', l: 'Type', t: 'select', opts: [['Advance', 'Advance'], ['Loan', 'Loan']] }, { k: 'opening', l: 'Opening balance (owed to you, or by you)', t: 'money' }, { k: 'dueDate', l: 'Due date', t: 'date' }, { k: 'notes', l: 'Notes', t: 'text' }] },
  funding: { store: 'funding', title: 'Construction funding sources', label: 'Funding source', fields: [{ k: 'project', l: 'Project', t: 'project' }, { k: 'name', l: 'Name', t: 'text' }, { k: 'expected', l: 'Expected amount', t: 'money' }, { k: 'expectedDate', l: 'Expected date', t: 'date' }, { k: 'notes', l: 'Notes', t: 'text' }] },
  statement: { store: 'statements', title: 'Card statements', label: 'Statement', fields: [{ k: 'card', l: 'Card', t: 'card' }, { k: 'statementDate', l: 'Statement date', t: 'date' }, { k: 'dueDate', l: 'Payment due date', t: 'date' }, { k: 'amount', l: 'Amount due', t: 'money' }, { k: 'minimum', l: 'Minimum due', t: 'money' }] },
};
const recSubtitle = {};
function recCurrency(type, f) {
  const R = REC[type];
  if (R.fields.some(x => x.t === 'project')) return projById(f.elements.project.value)?.currency;
  if (R.fields.some(x => x.t === 'card')) return accById(f.elements.card.value)?.currency;
  return f.elements.currency?.value;
}

function recInput(fd, rec, pid0) {
  const v = rec?.[fd.k];
  const id = `rf-${fd.k}`;
  if (fd.t === 'project') return `<select name="${fd.k}">${liveProjects().map(p => `<option value="${p.id}" ${(v || pid0) === p.id ? 'selected' : ''}>${esc(p.name)} (${p.currency})</option>`).join('')}</select>`;
  if (fd.t === 'card') return `<select name="${fd.k}">${liveAccounts().filter(a => a.kind === 'card').map(a => `<option value="${a.id}" ${v === a.id ? 'selected' : ''}>${esc(a.name)} (${a.currency})</option>`).join('')}</select>`;
  if (fd.t === 'cur') return `<select name="${fd.k}">${['BHD', 'INR', 'USD'].map(c => `<option ${v === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`;
  if (fd.t === 'select') return `<select name="${fd.k}">${fd.opts.map(([x, l]) => `<option value="${x}" ${v === x ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  if (fd.t === 'date') return `<input type="text" name="${fd.k}" value="${esc(toDMY(v || ''))}" placeholder="DD-MM-YYYY" id="${id}">`;
  if (fd.t === 'number') return `<input type="number" min="1" max="31" name="${fd.k}" value="${esc(v ?? '')}">`;
  if (fd.t === 'money') return `<input name="${fd.k}" inputmode="decimal" value="${esc(v != null && typeof v === 'number' ? '' : '')}" data-minor="${v ?? ''}">`;
  return `<input name="${fd.k}" value="${esc(v || '')}">`;
}

function openRecList(type) {
  const R = REC[type];
  const rows = S[R.store].filter(x => !x.deleted).sort((a, b) => String(a.name || a.division || '').localeCompare(String(b.name || b.division || '')));
  const sub = {};
  if (type === 'party') for (const r of partyViews(S, today)) sub[r.name] = `out ${fmt(r.debit, r.currency)} · in ${fmt(r.credit, r.currency)}`;
  if (type === 'advance') for (const r of advanceViews(S, today)) sub[r.id] = `balance ${fmt(r.balance, r.currency)} · paid ${fmt(r.paid, r.currency)} · received ${fmt(r.received, r.currency)}`;
  if (type === 'funding') for (const r of fundingViews(S, today)) sub[r.id] = `received ${fmt(r.received, r.currency)} of ${fmt(r.expected, r.currency)} · ${r.status}`;
  if (type === 'plan') for (const r of planViews(S)) sub[r.id] = `deposits ${fmt(r.deposits, r.currency)} · target ${fmt(r.target, r.currency)}`;
  if (type === 'statement') for (const x of S.statements.filter(x => !x.deleted)) sub[x.id] = `${accById(x.card)?.name || 'card'} · due ${toDMY(x.dueDate)}`;
  const budgets = type === 'budget' ? budgetViews(S, today).map(b => `<p class="muted"><b>${esc(b.name)}</b>: planned ${fmt(b.planned, b.currency)} · spent ${fmt(b.spent, b.currency)} · left ${fmt(b.left, b.currency)} <button class="ghost" data-ledger="budget" data-id="${b.project}">Ledger</button></p>`).join('') : '';
  const cards = type === 'statement' ? cardViews(S, today).map(c => `<p class="muted"><b>${esc(c.name)}</b>: owed ${fmt(c.owed, c.currency)}</p>`).join('') : '';
  const list = rows.map(r => `<div class="ledger-row"><button class="row" data-rec="${type}" data-id="${r.id}">
      <div><b>${esc(r.name || r.division || r.card || '')}</b><small>${esc(sub[r.id] || (type === 'party' ? sub[r.name] : '') || (r.currency || ''))}</small></div>
      <span>${type === 'budget' ? fmt(r.amount, projById(r.project)?.currency) : ''}</span></button>
      ${['advance', 'party', 'funding', 'plan', 'statement'].includes(type) ? `<div class="actions"><button class="ghost" data-ledger="${type}" data-id="${r.id}">Ledger</button></div>` : ''}</div>`).join('');
  $('#recBody').innerHTML = `<div class="split"><h2>${esc(R.title)}</h2></div>${budgets}${cards}
    ${list || '<p class="muted">Nothing yet.</p>'}
    <div class="actions"><button class="primary" data-rec-new="${type}">+ Add ${esc(R.label.toLowerCase())}</button></div>
    <p class="muted">Money figures follow the old DSi Finance App's rules.</p>`;
  $('#recDialog').dataset.type = type;
  $('#recDialog').showModal();
}

function openRecForm(type, id) {
  const R = REC[type];
  const rec = id ? S[R.store].find(x => x.id === id) : null;
  const pid0 = pid !== 'all' ? pid : liveProjects()[0]?.id;
  const fields = R.fields.map(fd => {
    if (fd.t === 'money') {
      const cur = fd.k && R.fields.some(x => x.t === 'project') ? projById(rec?.project || pid0)?.currency : (R.fields.some(x => x.t === 'card') ? accById(rec?.card || liveAccounts().find(a => a.kind === 'card')?.id)?.currency : (rec?.currency || 'BHD'));
      const val = rec && rec[fd.k] != null ? toPlain(rec[fd.k], cur) : '';
      return `<label>${esc(fd.l)} <span class="cur">${cur || ''}</span><input name="${fd.k}" inputmode="decimal" value="${esc(val)}"></label>`;
    }
    return `<label>${esc(fd.l)}${recInput(fd, rec, pid0)}</label>`;
  }).join('');
  $('#recBody').innerHTML = `<form id="recForm" class="stack" data-type="${type}" data-id="${id || ''}">
    <h2>${rec ? 'Edit' : 'New'} ${esc(R.label.toLowerCase())}</h2>${fields}
    <p id="recError" class="error" role="alert"></p>
    <div class="actions">${rec ? `<button type="button" class="danger" data-rec-del="${type}" data-id="${id}">Delete</button>` : ''}<span class="grow"></span>
      <button type="button" class="ghost" data-rec-list="${type}">Back</button><button class="primary">Save</button></div></form>`;
  $('#recDialog').dataset.type = type;
  $('#recDialog').showModal();
}

async function saveRecForm(f) {
  const type = f.dataset.type, R = REC[type], id = f.dataset.id;
  try {
    const cur = recCurrency(type, f);
    const prev = id ? S[R.store].find(x => x.id === id) || {} : {};
    const rec = { ...prev, id: id || crypto.randomUUID(), deleted: false };
    for (const fd of R.fields) {
      const raw = f.elements[fd.k]?.value ?? '';
      if (fd.t === 'money') {
        rec[fd.k] = raw.trim() === '' ? 0 : toMinor(raw, cur, fd.k === 'opening');
      } else if (fd.t === 'number') {
        const n = raw.trim() === '' ? null : Number(raw);
        if (n != null && (!Number.isInteger(n) || n < 1 || n > 31)) throw new Error('Day must be from 1 to 31');
        rec[fd.k] = n;
      } else if (fd.t === 'date') {
        rec[fd.k] = raw.trim() ? fromDMY(raw) : null;
      } else {
        rec[fd.k] = String(raw).trim();
      }
    }
    const nameKey = R.fields.find(x => x.k === 'name' || x.k === 'division')?.k;
    if (nameKey && !rec[nameKey]) throw new Error('Enter a name');
    if (type === 'party' && S.parties.some(p => !p.deleted && p.id !== rec.id && p.currency === rec.currency && p.name.toLowerCase() === rec.name.toLowerCase())) throw new Error('This party already exists in this currency');
    if (type === 'funding' && prev.receipts) rec.receipts = prev.receipts;
    if (type === 'statement' && !rec.card) throw new Error('Choose a card');
    if (type === 'advance' && !rec.project) throw new Error('Choose a project');
    await writeRows(R.store, [rec]);
    openRecList(type);
  } catch (err) {
    f.querySelector('#recError').textContent = err.message;
  }
}

async function deleteRec(type, id) {
  const R = REC[type];
  const used = S.txs.some(t => !t.deleted && (t.party_id === id || t.advance_id === id || t.plan_id === id || t.pay_ref === id));
  if (used) { $('#recError') && (($('#recError').textContent = 'This is used by transactions. Change those first.')); return; }
  if (!confirm('Delete this record?')) return;
  const rec = S[R.store].find(x => x.id === id);
  if (rec) await writeRows(R.store, [{ ...rec, deleted: true }]);
  openRecList(type);
}

// Construction funding: receipts that make up what has been received.
function openReceipts(fundId) {
  const fund = S.funding.find(x => x.id === fundId);
  if (!fund) return;
  const cur = projById(fund.project)?.currency;
  const linked = new Set(S.funding.filter(x => !x.deleted).flatMap(x => (x.receipts || []).map(r => r.entry)));
  const used = (fund.receipts || []).map(r => `<div class="row"><div><b>${esc(S.txs.find(t => t.id === r.entry)?.category || 'Receipt')}</b><small>${esc(toDMY(S.txs.find(t => t.id === r.entry)?.date || ''))}</small></div>
    <span>${fmt(r.amount, cur)} <button class="ghost" data-fund-unlink="${fund.id}" data-entry="${r.entry}">Remove</button></span></div>`).join('');
  const options = S.txs.filter(t => !t.deleted && t.type === 'income' && !linked.has(t.id) && projById(accById(t.account_id)?.project_id || t.project_id)?.id === fund.project)
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200)
    .map(t => `<option value="${t.id}" data-amount="${toPlain(t.amount, cur)}">${toDMY(t.date)} · ${esc(t.category || 'Income')} · ${toPlain(t.amount, cur)}</option>`).join('');
  $('#recBody').innerHTML = `<h2>Receipts for ${esc(fund.name)}</h2>
    <p class="muted">Expected ${fmt(fund.expected, cur)}. Link the income transactions that actually arrived.</p>
    ${used || '<p class="muted">No receipts linked yet.</p>'}
    ${options ? `<form id="fundLinkForm" class="stack" data-id="${fund.id}">
      <label>Income transaction<select name="entry">${options}</select></label>
      <label>Amount <span class="cur">${cur}</span><input name="amount" inputmode="decimal" required></label>
      <p id="fundError" class="error" role="alert"></p>
      <div class="actions"><span class="grow"></span><button class="ghost" data-rec-list="funding">Back</button><button class="primary">Link receipt</button></div></form>`
      : '<p class="muted">No unlinked income in this project. Add it as an income transaction first.</p><div class="actions"><button class="ghost" data-rec-list="funding">Back</button></div>'}`;
  $('#recDialog').dataset.type = 'funding';
  $('#recDialog').showModal();
}

document.addEventListener('submit', async e => {
  if (e.target.id === 'recForm') { e.preventDefault(); return saveRecForm(e.target); }
  if (e.target.id === 'fundLinkForm') {
    e.preventDefault();
    const f = e.target;
    try {
      const fund = S.funding.find(x => x.id === f.dataset.id);
      const cur = projById(fund.project)?.currency;
      const amount = toMinor(f.elements.amount.value, cur);
      const next = { ...fund, receipts: [...(fund.receipts || []), { entry: f.elements.entry.value, amount }] };
      checkFunding(S, [{ id: next.id, project: next.project, name: next.name, expected: next.expected, currency: cur, receipts: next.receipts.map(r => ({ entry: r.entry, amount: r.amount })) }]);
      await writeRows('funding', [next]);
      openReceipts(fund.id);
    } catch (err) {
      f.querySelector('#fundError').textContent = err.message;
    }
  }
});

document.addEventListener('click', async e => {
  const t = e.target;
  const row = t.closest('[data-rec]');
  if (row && !t.closest('[data-fund-unlink]')) return openRecForm(row.dataset.rec, row.dataset.id);
  if (t.dataset.recNew) return openRecForm(t.dataset.recNew);
  if (t.dataset.ledger) return openLedger(t.dataset.ledger, t.dataset.id);
  if (t.dataset.recList) return openRecList(t.dataset.recList);
  if (t.dataset.recDel) return deleteRec(t.dataset.recDel, t.dataset.id);
  if (t.dataset.fundUnlink) {
    const fund = S.funding.find(x => x.id === t.dataset.fundUnlink);
    await writeRows('funding', [{ ...fund, receipts: fund.receipts.filter(r => r.entry !== t.dataset.entry) }]);
    return openReceipts(fund.id);
  }
});
$('#recClose').onclick = () => $('#recDialog').close();

// ---------- Project form ----------
function openProj(p = null) {
  const f = $('#projForm');
  f.reset();
  f.dataset.id = p?.id || '';
  $('#projTitle').textContent = p ? 'Edit project' : 'New project';
  f.elements.name.value = p?.name || '';
  f.elements.currency.value = p?.currency || 'BHD';
  const n = p ? projectCount(p.id) : 0;
  f.elements.currency.disabled = !!n;
  $('#projHint').textContent = n
    ? `${n} account(s) use this project, so its currency cannot change. Delete the accounts first to remove the project.`
    : 'Each project holds one currency.';
  $('#projDelete').hidden = !p || n > 0;
  $('#projError').textContent = '';
  $('#projDialog').showModal();
}

async function saveProj(e) {
  e.preventDefault();
  const f = $('#projForm');
  try {
    const id = f.dataset.id || crypto.randomUUID();
    const name = validateProject(f.elements.name.value, f.elements.currency.value, S.projects, id);
    const cur = projById(id)?.currency || f.elements.currency.value;
    await writeRows('projects', [{ id, name, currency: cur, deleted: false }]);
    $('#projDialog').close();
    render();
  } catch (err) {
    $('#projError').textContent = err.message;
  }
}

async function deleteProj() {
  const id = $('#projForm').dataset.id;
  const p = projById(id);
  if (!p) return;
  if (projectCount(id)) { $('#projError').textContent = 'Delete or move its accounts first.'; return; }
  if (!confirm(`Delete project "${p.name}"?`)) return;
  await writeRows('projects', [{ ...p, deleted: true }]);
  if (pid === id) pid = 'all';
  $('#projDialog').close();
  render();
}

// ---------- Google Drive sync ----------
// ---------- Google Drive sync ----------
const driveReady = () => !!cfg.googleClientId;
const tokenValid = () => !!token && Date.now() < token.expires - 60000;

let pinRec = null, locked = false, hiddenAt = 0, lockState = { fails: 0, until: 0 };

async function loadSecurity() {
  pinRec = (await getMeta('pin')) || null;
  const saved = await getMeta('drive-token');
  if (saved && saved.expires > Date.now() + 60000) token = saved;
}

async function setToken(t) {
  token = t;
  await setMeta('drive-token', t);
}

function scheduleSync() {
  if (!driveReady()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), 3000);
}

// Connects this device to Google Drive. Must start from a tap, so Google can show its sign-in window.
async function connectDrive() {
  if (!driveReady()) throw new Error('Google Drive is not set up yet. See README, section 2.');
  await setToken(await getToken(cfg.googleClientId));
  await sync(true);
}

async function sync(manual = false) {
  if (!driveReady()) { if (manual) setStatus('Google Drive is not set up yet. See README, section 2.'); return; }
  if (!navigator.onLine) { if (manual) setStatus('Offline. Changes will sync when you reconnect.'); return; }
  if (!tokenValid()) {
    try { await setToken(await getToken(cfg.googleClientId, { silent: !manual })); }
    catch (_) { setStatus('Saved on this device. Open More and tap Sync now to send it to Google Drive.'); return; }
  }
  if (syncing) return;
  syncing = true;
  setStatus('Syncing with Google Drive…');
  try {
    drive = driveClient(token.token);
    const remote = await drive.readData();
    const local = localState(S);
    const { state, backup } = mergeState(local, remote);
    for (const t of TABLES) await putMany(t, state[t]);
    await drive.writeData(backup);
    await loadAll();
    await drive.writeDues(duesFile(duesNow(S, today, 30), fmt, today));
    setStatus('Synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    if (!dialogOpen()) render();
  } catch (err) {
    setStatus('Sync failed: ' + (err.message || err) + '. Your data is safe on this device.');
  } finally {
    syncing = false;
  }
}

// ---------- Downloads ----------
function downloadBytes(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportJson() {
  const more = Object.fromEntries(RECORD_TABLES.map(t => [t, S[t]]));
  const bytes = new TextEncoder().encode(JSON.stringify(makeBackup(S.accounts, S.txs, S.projects, S.loans, more), null, 2));
  downloadBytes(`dsi-digital-backup-${todayStr()}.json`, bytes, 'application/json');
  setStatus('Backup file saved. Keep it somewhere safe.');
}

function exportCsv() {
  const txs = txsIn(S.txs, S.accounts, pid);
  downloadBytes(`dsi-digital-${pid === 'all' ? 'all' : projName(pid).replace(/\W+/g, '-')}-${todayStr()}.csv`,
    new TextEncoder().encode(toCSV(txs, S.accounts)), 'text/csv;charset=utf-8');
}

// ---------- Backup restore ----------
async function restore(file) {
  try {
    const text = await file.text();
    let data;
    try {
      data = parseBackup(text);
    } catch (err) {
      // A file from the old DSi Finance App goes through the import preview instead.
      if (text.includes('"projects"') && text.includes('"entries"')) return chooseOldBackup(file);
      throw err;
    }
    const ok = confirm(`Restore ${data.projects.length} projects, ${data.accounts.length} accounts and ${data.transactions.length} transactions from this file?\n\nWhere the same record exists in both places, the newer one is kept. Nothing is deleted.`);
    if (!ok) return;
    const mergeInto = async (store, rows, table) => {
      const local = new Map((await getAll(store)).map(r => [r.id, r]));
      const out = [];
      for (const raw of rows) {
        const row = normalize(table, raw);
        if (table === 'transactions' && (!TYPES.includes(row.type) || !Number.isSafeInteger(row.amount))) continue;
        const keep = mergeRemote(local.get(row.id), row);
        if (keep) out.push({ ...keep, dirty: true });
      }
      await putMany(store, out);
      return out.length;
    };
    const lo = await mergeInto('loans', data.loans, 'loans');
    for (const t of RECORD_TABLES) await mergeInto(t, data[t] || [], t);
    const p = await mergeInto('projects', data.projects, 'projects');
    const a = await mergeInto('accounts', data.accounts, 'accounts');
    const t = await mergeInto('transactions', data.transactions, 'transactions');
    await loadAll();
    await migrate();
    scheduleSync();
    render();
    setStatus(`Restored ${p} projects, ${a} accounts, ${lo} loans and ${t} transactions.`);
  } catch (err) {
    setStatus('Restore failed: ' + err.message);
  }
}

// ---------- PDF reports ----------
function openReport() {
  const f = $('#repForm');
  f.reset();
  f.elements.kind.value = 'month';
  f.elements.month.value = today.slice(0, 7);
  f.elements.account_id.innerHTML = accOptions(liveAccounts()[0]?.id);
  f.elements.from.value = toDMY(`${today.slice(0, 4)}-01-01`);
  f.elements.to.value = toDMY(today);
  toggleReportKind();
  $('#repError').textContent = '';
  $('#repDialog').showModal();
}

function toggleReportKind() {
  const isAccount = $('#repForm').elements.kind.value === 'account';
  $('#repMonthWrap').hidden = isAccount;
  $('#repAccWrap').hidden = !isAccount;
}

// The monthly statement follows the project selected on screen.
function buildReport() {
  const f = $('#repForm'), kind = f.elements.kind.value;
  if (kind === 'month') {
    const month = f.elements.month.value;
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Choose a month.');
    return {
      bytes: monthlyPdf({ accounts: S.accounts.filter(a => pid === 'all' || a.project_id === pid), txs: txsIn(S.txs, S.accounts, pid), month, generated: today }),
      name: `DSi-Digital-statement-${pid === 'all' ? 'all' : projName(pid)}-${month}.pdf`.replace(/[^A-Za-z0-9._-]+/g, '-'),
    };
  }
  const accountId = f.elements.account_id.value, from = fromDMY(f.elements.from.value), to = fromDMY(f.elements.to.value);
  const acc = accById(accountId);
  if (!acc) throw new Error('Choose an account.');
  if (!from || !to) throw new Error('Choose both dates.');
  if (from > to) throw new Error('The "From" date must be before the "To" date.');
  return {
    bytes: accountPdf({ accounts: S.accounts, txs: S.txs, accountId, from, to, generated: today }),
    name: `DSi-Digital-${acc.name}-${from}-to-${to}.pdf`.replace(/[^A-Za-z0-9._-]+/g, '-'),
  };
}

// ---------- Old DSi Finance import ----------
async function chooseOldBackup(file) {
  try {
    pendingImport = await convertOldBackup(await file.text());
    showImportPreview(pendingImport, file.name);
  } catch (err) {
    setStatus('Import failed: ' + err.message);
  }
}

function showImportPreview({ projects, accounts, transactions, loans = [], report }, fileName) {
  const bal = balances(accounts, transactions);
  const projRows = projects.map(p => `<li>${esc(p.name)} (${p.currency})</li>`).join('');
  const rows = accounts.map(a => `<tr><td>${esc(a.name)}</td><td>${esc(projects.find(p => p.id === a.project_id)?.name || '')}</td><td class="r">${toPlain(bal.get(a.id), a.currency)} ${a.currency}</td></tr>`).join('');
  const types = Object.entries(report.byType).map(([k, v]) => `${v} ${k}`).join(', ');
  const notImported = Object.entries(report.ignored).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ');
  const skipped = report.skipped.length
    ? `<h3>Skipped (${report.skipped.length})</h3><ul class="notes">${report.skipped.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : '';
  $('#impBody').innerHTML = `
    <p class="muted">File: ${esc(fileName)}</p>
    <h3>Projects to create (${projects.length})</h3><ul class="notes">${projRows}</ul>
    <h3>Loans (${loans.length})</h3>
    <ul class="notes">${loans.map(l => `<li>${esc(l.name)} · ${l.mode === 'emi' ? 'EMI ' + toPlain(l.emi, projects.find(p => p.id === l.project)?.currency) + ' · ' + l.rate + '% a year' : 'no fixed schedule'}</li>`).join('')}</ul>
    <h3>Accounts (${accounts.length})</h3>
    <table class="tbl"><thead><tr><th>Account</th><th>Project</th><th class="r">Balance after import</th></tr></thead><tbody>${rows}</tbody></table>
    <h3>Transactions to import (${transactions.length})</h3><p class="muted">${esc(types || 'None')}</p>
    <h3>Not imported</h3><p class="muted">${esc(notImported || 'Nothing')}</p>
    ${skipped}
    <h3>Please note</h3>
    <ul class="notes">${report.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
    <p class="muted">Compare these balances with the old app. If they match, press Import. Importing the same file again replaces those items instead of duplicating them.</p>`;
  $('#impError').textContent = '';
  $('#impDialog').showModal();
}

async function confirmImport() {
  if (!pendingImport) return;
  try {
    const { projects, accounts, transactions, loans } = pendingImport;
    const nRec = RECORD_TABLES.reduce((n, t) => n + (pendingImport[t]?.length || 0), 0);
    for (const t of RECORD_TABLES) await putMany(t, pendingImport[t] || []);
    await putMany('loans', loans || []);
    await putMany('projects', projects);
    await putMany('accounts', accounts);
    await putMany('transactions', transactions);
    pendingImport = null;
    await loadAll();
    scheduleSync();
    $('#impDialog').close();
    view = 'home'; pid = 'all';
    render();
    setStatus(`Imported ${projects.length} projects, ${accounts.length} accounts, ${(loans || []).length} loans, ${nRec} records and ${transactions.length} transactions.`);
  } catch (err) {
    $('#impError').textContent = err.message;
  }
}

// ---------- Payment reminders on this device ----------
const urlB64 = s => Uint8Array.from(atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function enableDesktopReminders() {
  if (!cfg.vapidPublicKey) throw new Error('Reminders are not set up yet. Ask for the reminder setup (README, section 9).');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser cannot receive reminders. On iPhone, add the app to your Home Screen first.');
  if (!tokenValid() || !driveReady()) throw new Error('Connect Google Drive first (More → Google Drive), so the reminder service can find this device.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed on this device.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(cfg.vapidPublicKey) }));
  const json = sub.toJSON();
  const drive = driveClient(token.token);
  const list = (await drive.readSubs()).filter(x => x.endpoint !== json.endpoint);
  list.push({ endpoint: json.endpoint, keys: json.keys, device: navigator.userAgent.slice(0, 80), added: today });
  await drive.writeSubs(list);
  $('#remMsg').textContent = 'Reminders are on for this device. You will get a notification when a payment is due.';
}

async function testNotification() {
  if (!('Notification' in window)) throw new Error('This browser cannot show notifications.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed on this device.');
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('DSi Digital', { body: 'Test notification. Payment reminders will look like this.', icon: 'icon.svg', tag: 'dsi-test' });
  $('#remMsg').textContent = 'Test notification sent.';
}

// ---------- PIN lock ----------
function showLock() {
  if (!pinRec) return;
  locked = true;
  $('#lock').hidden = false;
  $('#lockPin').value = '';
  $('#lockMsg').textContent = '';
  setTimeout(() => $('#lockPin').focus(), 50);
}

function hideLock() {
  locked = false;
  $('#lock').hidden = true;
}

$('#lockForm').addEventListener('submit', async e => {
  e.preventDefault();
  const left = lockoutLeft(lockState);
  if (left) { $('#lockMsg').textContent = `Too many tries. Wait ${Math.ceil(left / 1000)} seconds.`; return; }
  const ok = await checkPin($('#lockPin').value, pinRec);
  if (ok) {
    lockState = { fails: 0, until: 0 };
    hideLock();
    notifyDues();
  } else {
    registerFailure(lockState);
    $('#lockPin').value = '';
    $('#lockMsg').textContent = lockoutLeft(lockState) ? 'Too many tries. Wait 30 seconds.' : 'Wrong PIN. Try again.';
  }
});

// Forgot the PIN: signing in with your Google account proves it is you, then the PIN is removed.
$('#lockForgot').onclick = async () => {
  try {
    if (!driveReady()) throw new Error('Google Drive is not set up on this device, so the PIN cannot be reset here.');
    await setToken(await getToken(cfg.googleClientId));
    await setMeta('pin', null);
    pinRec = null; lockState = { fails: 0, until: 0 };
    hideLock();
    setStatus('PIN removed. You can set a new one in More → Security.');
  } catch (err) {
    $('#lockMsg').textContent = err.message;
  }
};

function openPinForm(mode) {
  $('#recBody').innerHTML = `
    <form id="pinForm" class="stack" data-mode="${mode}">
      <h2>${mode === 'set' ? 'Set a PIN' : mode === 'change' ? 'Change PIN' : 'Remove PIN'}</h2>
      ${mode === 'set' ? '<p class="muted">Choose 4 to 6 digits. You will type it each time the app opens.</p>' : ''}
      ${mode !== 'set' ? '<label>Current PIN<input name="current" type="password" inputmode="numeric" maxlength="6" required></label>' : ''}
      ${mode !== 'remove' ? `<label>New PIN<input name="next" type="password" inputmode="numeric" maxlength="6" required></label>
      <label>Type the new PIN again<input name="confirm" type="password" inputmode="numeric" maxlength="6" required></label>` : ''}
      <p id="pinError" class="error" role="alert"></p>
      <div class="actions"><button type="button" class="ghost" data-rec-close>Cancel</button><span class="grow"></span><button class="primary">Save</button></div>
    </form>`;
  $('#recDialog').dataset.type = 'pin';
  $('#recDialog').showModal();
}

document.addEventListener('submit', async e => {
  if (e.target.id !== 'pinForm') return;
  e.preventDefault();
  const f = e.target, mode = f.dataset.mode;
  try {
    if (mode !== 'set' && !(await checkPin(f.elements.current.value, pinRec))) throw new Error('That is not your current PIN.');
    if (mode === 'remove') {
      await setMeta('pin', null);
      pinRec = null;
    } else {
      if (f.elements.next.value !== f.elements.confirm.value) throw new Error('The two PINs do not match.');
      if (!validPin(f.elements.next.value)) throw new Error('The PIN must be 4 to 6 digits.');
      pinRec = await makePinRecord(f.elements.next.value);
      await setMeta('pin', pinRec);
    }
    $('#recDialog').close();
    render();
    setStatus(mode === 'remove' ? 'PIN removed.' : 'PIN saved on this device.');
  } catch (err) {
    f.querySelector('#pinError').textContent = err.message;
  }
});

// ---------- Notifications inside the app ----------
// One notification per payment per day, while the app is open.
async function notifyDues() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  for (const d of duesNow(S, today, 3)) {
    const key = `notified:${d.id}:${d.date}:${today}`;
    if (await getMeta(key)) continue;
    await setMeta(key, true);
    new Notification('Payment due soon', { body: `${d.name}: ${fmt(d.amount, d.currency)} due ${toDMY(d.date)}`, icon: 'icon.svg', tag: key });
  }
}

// ---------- Excel export / import ----------
function exportExcel(template) {
  try {
    if (!window.XLSX) throw new Error('The Excel library did not load. Check your connection and reload.');
    const data = template ? { projects: [], accounts: [], txs: [] } : { projects: S.projects, accounts: S.accounts, txs: S.txs };
    downloadBytes(template ? 'DSi-Digital-template.xlsx' : `DSi-Digital-${todayStr()}.xlsx`, workbookBytes(window.XLSX, data),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    setStatus(template ? 'Template saved.' : 'Excel file saved.');
  } catch (err) { setStatus('Excel export failed: ' + err.message); }
}

async function chooseExcel(file) {
  try {
    if (!window.XLSX) throw new Error('The Excel library did not load. Check your connection and reload.');
    pendingXls = parseWorkbook(window.XLSX, await file.arrayBuffer(), { projects: S.projects, accounts: S.accounts, txs: S.txs });
    showXlsPreview(pendingXls, file.name);
  } catch (err) {
    setStatus('Excel import failed: ' + err.message);
  }
}

function showXlsPreview(result, fileName) {
  const c = result.counts, ok = result.errors.length === 0;
  const errs = result.errors.length
    ? `<h3>Please fix these rows in Excel, then import again (${result.errors.length})</h3>
       <ul class="notes">${result.errors.slice(0, 60).map(e => `<li>${esc(e.sheet)} row ${e.row}: ${esc(e.message)}</li>`).join('')}</ul>` : '';
  $('#xlsBody').innerHTML = `
    <p class="muted">File: ${esc(fileName)}</p>
    <h3>Projects</h3><p class="muted">${c.projNew} new, ${c.projUpdated} to update</p>
    <h3>Accounts</h3><p class="muted">${c.accNew} new, ${c.accUpdated} to update</p>
    <h3>Transactions</h3><p class="muted">${c.txNew} new, ${c.txUpdated} to update (matched by ID)</p>
    ${c.possibleDuplicates ? `<p class="error">${c.possibleDuplicates} row(s) have no ID but match a transaction already in the app (same date, type, amount and account). They will be added again. Keep their IDs from an export, or remove the rows if they are duplicates.</p>` : ''}
    ${ok ? '<p class="muted">Press Import to save. Rows with an ID that already exists are updated, not duplicated.</p>' : ''}
    ${errs}`;
  $('#xlsError').textContent = '';
  $('#xlsConfirm').disabled = !ok;
  $('#xlsDialog').showModal();
}

async function confirmXls() {
  if (!pendingXls || pendingXls.errors.length) return;
  try {
    const { projects, accounts, transactions, counts } = pendingXls;
    await putMany('projects', projects);
    await putMany('accounts', accounts);
    await putMany('transactions', transactions);
    pendingXls = null;
    await loadAll();
    scheduleSync();
    $('#xlsDialog').close();
    render();
    setStatus(`Excel import saved: ${counts.projNew + counts.projUpdated} projects, ${counts.accNew + counts.accUpdated} accounts, ${counts.txNew + counts.txUpdated} transactions.`);
  } catch (err) {
    $('#xlsError').textContent = err.message;
  }
}

// ---------- Events ----------
$('#fab').onclick = () => openTx();
$$('.tab').forEach(b => b.onclick = () => { view = b.dataset.view; render(); });

$('#txForm').addEventListener('submit', saveTx);
$$('#txForm input[name=type]').forEach(r => r.addEventListener('change', () => updateTxForm()));
$('#txForm').elements.account_id.addEventListener('change', () => updateTxForm());
$('#txCancel').onclick = () => $('#txDialog').close();
$('#txDelete').onclick = deleteTx;

$('#accForm').addEventListener('submit', saveAcc);
$('#accForm').elements.kind.addEventListener('change', toggleCardFields);
$('#accForm').elements.project_id.addEventListener('change', e => {
  $('#accCur').textContent = projById(e.target.value)?.currency || '';
});
$('#accCancel').onclick = () => $('#accDialog').close();
$('#accDelete').onclick = deleteAcc;

$('#projForm').addEventListener('submit', saveProj);
$('#projCancel').onclick = () => $('#projDialog').close();
$('#projDelete').onclick = deleteProj;

$('#repCancel').onclick = () => $('#repDialog').close();
$$('#repForm input[name=kind]').forEach(r => r.addEventListener('change', toggleReportKind));
$('#repForm').addEventListener('submit', e => {
  e.preventDefault();
  try {
    const { bytes } = buildReport();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $('#repError').textContent = '';
  } catch (err) { $('#repError').textContent = err.message; }
});
$('#repSave').onclick = () => {
  try {
    const { bytes, name } = buildReport();
    downloadBytes(name, bytes, 'application/pdf');
    $('#repError').textContent = '';
  } catch (err) { $('#repError').textContent = err.message; }
};

$('#impCancel').onclick = () => { pendingImport = null; $('#impDialog').close(); };
$('#impConfirm').onclick = confirmImport;
$('#xlsCancel').onclick = () => { pendingXls = null; $('#xlsDialog').close(); };
$('#xlsConfirm').onclick = confirmXls;

$('#main').addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.act) {
    case 'edit-tx': openTx(S.txs.find(t => t.id === id)); break;
    case 'edit-acc': openAcc(accById(id)); break;
    case 'open-loan': openLoan(id); break;
    case 'open-od': openOd(id); break;
    case 'rem-desktop': enableDesktopReminders().catch(err => { $('#remMsg').textContent = err.message; }); break;
    case 'rem-test': testNotification().catch(err => { $('#remMsg').textContent = err.message; }); break;
    case 'pin-set': openPinForm('set'); break;
    case 'pin-change': openPinForm('change'); break;
    case 'pin-remove': openPinForm('remove'); break;
    case 'rec-list': openRecList(el.dataset.type); break;
    case 'new-acc': openAcc(); break;
    case 'edit-proj': openProj(projById(id)); break;
    case 'new-proj': openProj(); break;
    case 'prev-month': period = { ...period, mode: 'month', month: shiftMonth(period.month, -1) }; render(); break;
    case 'next-month': period = { ...period, mode: 'month', month: shiftMonth(period.month, 1) }; render(); break;
    case 'sync-now': sync(true); break;
    case 'reports': openReport(); break;
    case 'drive-connect': connectDrive().catch(err => setStatus(err.message)); break;
    case 'xls-export': exportExcel(false); break;
    case 'xls-template': exportExcel(true); break;
    case 'xls-import': $('#xlsFile').click(); break;
    case 'import-old': $('#oldFile').click(); break;
    case 'export-json': exportJson(); break;
    case 'export-csv': exportCsv(); break;
    case 'restore': $('#restoreFile').click(); break;
  }
});

$('#main').addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'projSel') { pid = t.value; render(); }
  if (t.id === 'perMode') { period = { ...period, mode: t.value }; render(); }
  if (t.id === 'perMonth' && t.value) { period = { ...period, month: t.value }; render(); }
  if (t.id === 'perYear') { period = { ...period, year: t.value }; render(); }
  if (t.id === 'perFrom' || t.id === 'perTo') {
    try { period = { ...period, [t.id === 'perFrom' ? 'from' : 'to']: fromDMY(t.value) }; render(); }
    catch (err) { setStatus(err.message); }
  }
  if (t.id === 'restoreFile' && t.files[0]) restore(t.files[0]);
  if (t.id === 'oldFile' && t.files[0]) { const f = t.files[0]; t.value = ''; chooseOldBackup(f); }
  if (t.id === 'xlsFile' && t.files[0]) { const f = t.files[0]; t.value = ''; chooseExcel(f); }
});

$('#main').addEventListener('input', e => {
  if (e.target.id === 'search') { search = e.target.value; $('#txList').innerHTML = txListHtml(); }
});

// ---------- Start ----------
async function init() {
  document.title = APP;
  $('#appTitle').textContent = APP;
  await loadAll();
  await migrate();
  await loadSecurity();
  render();
  if (pinRec) showLock(); else notifyDues();
  setStatus(driveReady() ? 'This device · connect Google Drive in More' : 'This device only');
  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (pinRec && hiddenAt && Date.now() - hiddenAt > 60000) showLock();
    hiddenAt = 0;
    if (!locked) sync();
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
}

init().catch(err => setStatus('Could not start: ' + err.message));
