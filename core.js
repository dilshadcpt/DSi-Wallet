// Pure logic only (no DOM, no storage). Money is stored as whole minor units:
// BHD = fils (1/1000), INR = paise (1/100), USD = cents (1/100).
export const CURRENCIES = { BHD: 3, INR: 2, USD: 2 };
export const TYPES = ['income', 'expense', 'transfer'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const COLS = {
  projects: ['id', 'name', 'currency', 'opening_date', 'updated_at', 'deleted'],
  accounts: ['id', 'project_id', 'name', 'currency', 'opening', 'kind', 'statement_day', 'due_day', 'credit_limit', 'od', 'card_ref', 'updated_at', 'deleted'],
  advances: ['id', 'project', 'name', 'kind', 'opening', 'dueDate', 'notes', 'updated_at', 'deleted'],
  funding: ['id', 'project', 'name', 'expected', 'expectedDate', 'notes', 'receipts', 'updated_at', 'deleted'],
  parties: ['id', 'name', 'currency', 'updated_at', 'deleted'],
  budgets: ['id', 'project', 'division', 'amount', 'updated_at', 'deleted'],
  plans: ['id', 'project', 'name', 'kind', 'target', 'day', 'current', 'valuationDate', 'updated_at', 'deleted'],
  statements: ['id', 'card', 'statementDate', 'dueDate', 'amount', 'minimum', 'updated_at', 'deleted'],
  loans: ['id', 'project', 'name', 'opening', 'emi', 'rate', 'months', 'firstDue', 'mode', 'interest', 'projection', 'updated_at', 'deleted'],
  transactions: ['id', 'date', 'type', 'amount', 'account_id', 'to_account_id', 'category', 'note', 'loan_id', 'principal', 'interest', 'due_date', 'adjustment', 'fee', 'received', 'source_type', 'advance_id', 'party_id', 'plan_id', 'pay_kind', 'pay_ref', 'project_id', 'updated_at', 'deleted'],
};

// "12.500" -> 12500 BHD fils. Rejects ambiguous input such as "12,5".
export function toMinor(input, currency, allowNegative = false) {
  const d = CURRENCIES[currency];
  if (d === undefined) throw new Error('Choose a currency');
  let t = String(input ?? '').trim().replace(/\s/g, '');
  let neg = false;
  if (t.startsWith('-')) {
    if (!allowNegative) throw new Error('Amount cannot be negative');
    neg = true; t = t.slice(1);
  }
  if (t.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) throw new Error('Use a dot for decimals, for example 12.500');
    t = t.replace(/,/g, '');
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new Error('Enter a valid amount, for example 12.500');
  const frac = m[2] || '';
  if (frac.length > d) throw new Error(`${currency} allows up to ${d} decimal places`);
  const value = Number(m[1]) * 10 ** d + Number((frac + '0'.repeat(d)).slice(0, d) || 0);
  if (!Number.isSafeInteger(value)) throw new Error('Amount is too large');
  return neg ? -value : value;
}

export function toPlain(minor, currency) {
  const d = CURRENCIES[currency] ?? 2, p = 10 ** d, a = Math.abs(minor);
  const body = `${Math.floor(a / p)}${d ? '.' + String(a % p).padStart(d, '0') : ''}`;
  return (minor < 0 ? '-' : '') + body;
}

export function fmt(minor, currency) {
  const d = CURRENCIES[currency] ?? 2, p = 10 ** d, a = Math.abs(minor);
  const major = Math.floor(a / p), frac = a % p;
  const body = major.toLocaleString('en-US') + (d ? '.' + String(frac).padStart(d, '0') : '');
  return `${minor < 0 ? '−' : ''}${currency ? currency + ' ' : ''}${body}`;
}

// Live accounts, optionally only those in one project.
export function accountsIn(accounts, pid = 'all') {
  return accounts.filter(a => !a.deleted && (pid === 'all' || a.project_id === pid));
}

// Transactions that touch at least one account in the project.
export function txsIn(txs, accounts, pid = 'all') {
  if (pid === 'all') return txs;
  const ids = new Set(accountsIn(accounts, pid).map(a => a.id));
  return txs.filter(t => ids.has(t.account_id) || ids.has(t.to_account_id));
}

// Map of account id -> current balance (opening + movements). Deleted rows are ignored.
export function balances(accounts, txs) {
  const bal = new Map(accounts.filter(a => !a.deleted).map(a => [a.id, a.opening]));
  const add = (id, n) => { if (bal.has(id)) bal.set(id, bal.get(id) + n); };
  for (const t of txs) {
    if (t.deleted) continue;
    if (t.type === 'income') add(t.account_id, t.amount);
    else if (t.type === 'expense') add(t.account_id, -t.amount);
    else if (t.type === 'transfer') { add(t.account_id, -(t.amount + (t.fee || 0))); add(t.to_account_id, t.received ?? t.amount); }
  }
  return bal;
}

export function totalsByCurrency(accounts, bal) {
  const out = {};
  for (const a of accounts) if (!a.deleted) out[a.currency] = (out[a.currency] || 0) + (bal.get(a.id) || 0);
  return out;
}

// A period is { mode: 'month'|'year'|'custom'|'all', month: 'YYYY-MM', year: 'YYYY', from, to }.
export function periodRange(p) {
  switch (p.mode) {
    case 'month': {
      const [y, m] = p.month.split('-').map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { from: `${p.month}-01`, to: `${p.month}-${String(last).padStart(2, '0')}` };
    }
    case 'year': return { from: `${p.year}-01-01`, to: `${p.year}-12-31` };
    case 'custom': return { from: p.from, to: p.to };
    default: return { from: '0000-01-01', to: '9999-12-31' };
  }
}

export function periodLabel(p) {
  if (p.mode === 'month') { const [y, m] = p.month.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; }
  if (p.mode === 'year') return `Year ${p.year}`;
  if (p.mode === 'custom') return `${p.from} to ${p.to}`;
  return 'All dates';
}

// { BHD: { income, expense }, ... } for transactions dated from..to inside one project (or all).
export function periodSummary(txs, accounts, from, to, pid = 'all') {
  const cur = new Map(accounts.map(a => [a.id, a.currency]));
  const proj = new Map(accounts.map(a => [a.id, a.project_id]));
  const out = {};
  for (const t of txs) {
    if (t.deleted || t.type === 'transfer' || t.date < from || t.date > to) continue;
    if (pid !== 'all' && proj.get(t.account_id) !== pid) continue;
    const c = cur.get(t.account_id);
    if (!c) continue;
    out[c] ??= { income: 0, expense: 0 };
    out[c][t.type] += t.amount;
  }
  return out;
}

export function monthSummary(txs, accounts, month) {
  return periodSummary(txs, accounts, `${month}-01`, `${month}-31`);
}

export function validateTx(t, accounts) {
  const live = id => accounts.find(a => a.id === id && !a.deleted);
  if (!TYPES.includes(t.type)) throw new Error('Choose a transaction type');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date) || new Date(t.date + 'T00:00:00Z').toISOString().slice(0, 10) !== t.date) throw new Error('Choose a valid date');
  if (!Number.isSafeInteger(t.amount) || t.amount <= 0) throw new Error('Enter an amount greater than zero');
  const from = live(t.account_id);
  if (!from) throw new Error('Choose an account');
  if ((t.category || '').length > 80) throw new Error('Category must be 80 characters or fewer');
  if ((t.note || '').length > 500) throw new Error('Note must be 500 characters or fewer');
  if (t.type === 'transfer') {
    const to = live(t.to_account_id);
    if (!to) throw new Error('Choose the account to transfer to');
    if (to.id === from.id) throw new Error('Choose two different accounts');
    if (to.currency !== from.currency && (t.received == null)) throw new Error('Transfers must be between accounts in the same currency');
  }
  return true;
}

export function validateProject(name, currency, projects, id = '') {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('Enter a project name');
  if (n.length > 80) throw new Error('Project name must be 80 characters or fewer');
  if (!CURRENCIES[currency]) throw new Error('Choose BHD, INR or USD');
  if (projects.some(p => !p.deleted && p.id !== id && p.name.toLowerCase() === n.toLowerCase())) throw new Error('A project with this name already exists');
  return n;
}

// Makes sure every live account sits in a project of its own currency.
// Old data (before projects) gets one default project per currency. Returns only what changed.
export function ensureProjects(projects, accounts, { now, newId }) {
  const live = projects.filter(p => !p.deleted);
  const byCur = new Map();
  for (const p of live) if (!byCur.has(p.currency)) byCur.set(p.currency, p);
  const created = [];
  for (const a of accounts) {
    if (a.deleted || byCur.has(a.currency)) continue;
    const p = { id: newId(), name: `Main ${a.currency}`, currency: a.currency, updated_at: now, deleted: false, dirty: true };
    byCur.set(a.currency, p); created.push(p);
  }
  const known = new Map([...live, ...created].map(p => [p.id, p]));
  const fixed = [];
  for (const a of accounts) {
    if (a.deleted) continue;
    const p = known.get(a.project_id);
    if (p && p.currency === a.currency) continue;
    fixed.push({ ...a, project_id: byCur.get(a.currency).id, updated_at: now, dirty: true });
  }
  return { projects: created, accounts: fixed };
}

// Rows coming from the cloud or a backup file, reduced to known columns.
export function normalize(table, r) {
  const o = {};
  for (const c of COLS[table]) o[c] = r[c] ?? null;
  o.updated_at = Number(r.updated_at) || 0;
  o.deleted = !!r.deleted;
  if (table === 'accounts') {
    o.opening = Number(r.opening) || 0;
    o.kind = r.kind || 'bank';
    o.statement_day = r.statement_day == null ? null : Number(r.statement_day);
    o.due_day = r.due_day == null ? null : Number(r.due_day);
    o.credit_limit = r.credit_limit == null ? null : Number(r.credit_limit);
    o.od = r.od || null;
    o.card_ref = r.card_ref || null;
  }
  if (table === 'transactions') {
    o.amount = Number(r.amount);
    o.category = r.category || '';
    o.note = r.note || '';
    o.loan_id = r.loan_id || null;
    o.principal = r.principal == null ? null : Number(r.principal);
    o.interest = r.interest == null ? null : Number(r.interest);
    o.due_date = r.due_date || null;
    o.adjustment = !!r.adjustment;
    o.fee = Number(r.fee) || 0;
    o.received = r.received == null ? null : Number(r.received);
    o.source_type = r.source_type || null;
    o.advance_id = r.advance_id || null;
    o.party_id = r.party_id || null;
    o.plan_id = r.plan_id || null;
    o.pay_kind = r.pay_kind || null;
    o.pay_ref = r.pay_ref || null;
    o.project_id = r.project_id || null;
  }
  if (table === 'advances' || table === 'funding' || table === 'plans') {
    o.opening = r.opening == null ? undefined : Number(r.opening);
    if (table === 'funding') { o.expected = Number(r.expected) || 0; o.receipts = Array.isArray(r.receipts) ? r.receipts : []; }
    if (table === 'plans') { o.target = Number(r.target) || 0; o.current = Number(r.current) || 0; o.day = r.day == null ? null : Number(r.day); }
    if (table === 'advances') o.opening = Number(r.opening) || 0;
  }
  if (table === 'budgets') o.amount = Number(r.amount) || 0;
  if (table === 'statements') { o.amount = Number(r.amount) || 0; o.minimum = Number(r.minimum) || 0; }
  if (table === 'loans') {
    o.opening = Number(r.opening) || 0;
    o.emi = Number(r.emi) || 0;
    o.rate = Number(r.rate) || 0;
    o.months = r.months == null ? null : Number(r.months);
  }
  o.dirty = false;
  return o;
}

export function toRemote(table, r, uid) {
  const o = { user_id: uid };
  for (const c of COLS[table]) o[c] = r[c] ?? null;
  o.deleted = !!r.deleted;
  return o;
}

// Last-writer-wins by updated_at. Returns the row to keep, or null if local is already newer.
export function mergeRemote(local, remote) {
  if (!local || remote.updated_at > local.updated_at) return remote;
  return null;
}

export function makeBackup(accounts, txs, projects = [], loans = [], more = {}) {
  const clean = ({ dirty, ...r }) => r;
  const out = {
    app: 'dsi-wallet', format: 4, exportedAt: new Date().toISOString(),
    projects: projects.map(clean), accounts: accounts.map(clean), transactions: txs.map(clean), loans: loans.map(clean),
  };
  for (const k of ['advances', 'funding', 'parties', 'budgets', 'plans', 'statements']) out[k] = (more[k] || []).map(clean);
  return out;
}

// Accepts format 1 (no projects) and format 2.
export function parseBackup(text) {
  const d = JSON.parse(text);
  if (d.app !== 'dsi-wallet' || !Array.isArray(d.accounts) || !Array.isArray(d.transactions)) {
    throw new Error('This file is not a DSi Wallet backup');
  }
  if (!Array.isArray(d.projects)) d.projects = [];
  if (!Array.isArray(d.loans)) d.loans = [];
  for (const k of ['advances', 'funding', 'parties', 'budgets', 'plans', 'statements']) if (!Array.isArray(d[k])) d[k] = [];
  return d;
}

export function toCSV(txs, accounts) {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['date', 'type', 'amount', 'currency', 'account', 'to_account', 'category', 'note']];
  for (const t of txs.filter(x => !x.deleted).sort((a, b) => a.date.localeCompare(b.date))) {
    const a = byId.get(t.account_id) || {}, to = byId.get(t.to_account_id) || {};
    rows.push([t.date, t.type, toPlain(t.amount, a.currency), a.currency || '', a.name || '', to.name || '', t.category, t.note]);
  }
  return '\uFEFF' + rows.map(r => r.map(q).join(',')).join('\r\n');
}

// Next occurrence of a day-of-month (1-31) on or after `from` ('YYYY-MM-DD'). Short months use their last day.
export function nextDueDate(day, from) {
  let [y, m, d] = from.split('-').map(Number);
  const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  let dd = Math.min(day, lastDay(y, m));
  if (dd < d) {
    m += 1; if (m > 12) { m = 1; y += 1; }
    dd = Math.min(day, lastDay(y, m));
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

const dayGap = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// Payments due on credit cards within `withinDays` of today. A card only appears when it owes money.
export function dueItems(accounts, bal, today, withinDays = 14, pid = 'all') {
  const items = [];
  for (const a of accounts) {
    if (a.deleted || a.kind !== 'card' || !a.due_day) continue;
    if (pid !== 'all' && a.project_id !== pid) continue;
    const owed = -(bal.get(a.id) || 0);
    if (owed <= 0) continue;
    const date = nextDueDate(a.due_day, today);
    const gap = dayGap(today, date);
    if (gap < 0 || gap > withinDays) continue;
    items.push({ id: a.id, type: 'card', name: a.name, currency: a.currency, amount: owed, date, days: gap });
  }
  return items.sort((x, y) => x.date.localeCompare(y.date) || x.name.localeCompare(y.name));
}
