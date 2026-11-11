// Excel (.xlsx) export and import. The SheetJS library is passed in as XLSX.
// Sheets: Projects, Accounts, Transactions, Read me.
// Import checks every row first. If any row has an error, nothing is saved.
import { CURRENCIES, TYPES, toMinor, toPlain, balances, validateTx } from './core.js';

const PROJ_HEAD = ['ID', 'Name', 'Currency'];
const ACC_HEAD = ['ID', 'Project', 'Name', 'Currency', 'Opening balance', 'Current balance', 'Type', 'Statement day', 'Due day', 'Credit limit'];
const KINDS = { bank: 'bank', 'bank account': 'bank', cash: 'cash', card: 'card', 'credit card': 'card', other: 'other' };
const TX_HEAD = ['ID', 'Date', 'Type', 'Amount', 'Currency', 'Account', 'To account', 'Category', 'Note', 'Fee', 'Received'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HELP = [
  ['DSi Wallet · Excel data'], [''],
  ['Projects sheet (project books)'],
  ['Name: unique project name. Currency: BHD, INR or USD. Each project holds one currency.'], [''],
  ['Accounts sheet'],
  ['Project: a project name from the Projects sheet. Leave blank to use the first project in that currency.'],
  ['Name: the account name. Currency: BHD, INR or USD and must match the project.'],
  ['Opening balance: the balance before the first transaction. Use a minus sign for an overdraft.'],
  ['Current balance: for information only. It is ignored when you import.'],
  ['Type: Bank account, Cash, Credit card or Other. For a credit card, fill Statement day, Due day (1-31) and optionally Credit limit.'], [''],
  ['Transactions sheet'],
  ['Date: YYYY-MM-DD, for example 2026-11-10. 10/11/2026 (day/month/year) is also accepted.'],
  ['Type: Income, Expense or Transfer.'],
  ['Amount: a positive number. Up to 3 decimals for BHD, up to 2 for INR and USD. Use a dot for decimals.'],
  ['Account: the account name the money comes from or goes into.'],
  ['To account: only for Transfer. Must be in the same currency as Account.'],
  ['Category and Note: optional text.'], [''],
  ['ID columns: keep them when you edit a row, so it updates instead of being added again. Leave ID empty to add a new row.'],
  ['Currency in Transactions is for information only; it follows the Account.'],
];

const numFmt = c => (CURRENCIES[c] === 3 ? '#,##0.000' : '#,##0.00');
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);

export function buildWorkbook(XLSX, { projects = [], accounts = [], txs = [] }) {
  const bal = balances(accounts, txs);
  const projById = new Map(projects.map(p => [p.id, p]));
  const byId = new Map(accounts.map(a => [a.id, a]));
  const liveProj = projects.filter(p => !p.deleted).sort((a, b) => a.name.localeCompare(b.name));
  const liveAcc = accounts.filter(a => !a.deleted).sort((a, b) => a.name.localeCompare(b.name));
  const projRows = [PROJ_HEAD, ...liveProj.map(p => [p.id, p.name, p.currency])];
  const accRows = [ACC_HEAD, ...liveAcc.map(a => [
    a.id, projById.get(a.project_id)?.name || '', a.name, a.currency,
    Number(toPlain(a.opening, a.currency)), Number(toPlain(bal.get(a.id) || 0, a.currency)),
    a.kind === 'card' ? 'Credit card' : cap(a.kind || 'bank'), a.statement_day ?? '', a.due_day ?? '',
    a.credit_limit == null ? '' : Number(toPlain(a.credit_limit, a.currency)),
  ])];
  const txRows = [TX_HEAD, ...txs.filter(t => !t.deleted)
    .sort((a, b) => a.date.localeCompare(b.date) || a.updated_at - b.updated_at)
    .map(t => {
      const a = byId.get(t.account_id), to = byId.get(t.to_account_id), cur = a?.currency || '';
      const recv = t.received != null && to ? Number(toPlain(t.received, to.currency)) : '';
      return [t.id, t.date, cap(t.type), Number(toPlain(t.amount, cur)), cur, a?.name || '', to?.name || '', t.category || '', t.note || '',
        t.fee ? Number(toPlain(t.fee, cur)) : '', recv];
    })];

  const wb = XLSX.utils.book_new();
  const wsProj = XLSX.utils.aoa_to_sheet(projRows);
  const wsAcc = XLSX.utils.aoa_to_sheet(accRows);
  const wsTx = XLSX.utils.aoa_to_sheet(txRows);
  const wsHelp = XLSX.utils.aoa_to_sheet(HELP);
  wsProj['!cols'] = [{ wch: 38 }, { wch: 28 }, { wch: 10 }];
  wsAcc['!cols'] = [{ wch: 38 }, { wch: 24 }, { wch: 28 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 16 }];
  wsTx['!cols'] = [{ wch: 38 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 22 }, { wch: 22 }, { wch: 22 }, { wch: 36 }];
  wsHelp['!cols'] = [{ wch: 110 }];
  accRows.forEach((row, i) => {
    if (i === 0) return;
    for (const c of [4, 5, 9]) { const ref = XLSX.utils.encode_cell({ r: i, c }); if (wsAcc[ref]) wsAcc[ref].z = numFmt(row[3]); }
  });
  txRows.forEach((row, i) => {
    if (i === 0) return;
    const ref = XLSX.utils.encode_cell({ r: i, c: 3 });
    if (wsTx[ref]) wsTx[ref].z = numFmt(row[4]);
  });
  XLSX.utils.book_append_sheet(wb, wsProj, 'Projects');
  XLSX.utils.book_append_sheet(wb, wsAcc, 'Accounts');
  XLSX.utils.book_append_sheet(wb, wsTx, 'Transactions');
  XLSX.utils.book_append_sheet(wb, wsHelp, 'Read me');
  return wb;
}

export function workbookBytes(XLSX, data) {
  return new Uint8Array(XLSX.write(buildWorkbook(XLSX, data), { bookType: 'xlsx', type: 'array' }));
}

// Reads one sheet as objects keyed by lower-case header name. Blank rows are skipped.
function readSheet(XLSX, wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  if (!rows.length) return [];
  const head = rows[0].map(h => String(h).trim().toLowerCase());
  return rows.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { if (h) o[h] = r[j] ?? ''; });
    return o;
  }).filter(o => Object.keys(o).some(k => k !== '_row' && String(o[k]).trim() !== ''));
}

const text = v => String(v ?? '').trim();
const dayOrNull = (v, label) => {
  const t = String(v ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error(`${label} must be a day from 1 to 31`);
  return n;
};

// Excel dates arrive as serial numbers for date cells; text dates are accepted too.
export function parseDate(v) {
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const t = text(v);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  throw new Error(`Date "${t}" must look like 2026-11-10`);
}

// Returns { projects, accounts, transactions, errors, counts }. Rows are returned only when there are no errors.
export function parseWorkbook(XLSX, buffer, existing, { now = Date.now(), newId = () => crypto.randomUUID() } = {}) {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
  const errors = [];
  const fail = (sheet, row, message) => errors.push({ sheet, row, message });
  const projRows = readSheet(XLSX, wb, 'Projects');
  const accRows = readSheet(XLSX, wb, 'Accounts');
  const txRows = readSheet(XLSX, wb, 'Transactions');
  if (projRows === null && accRows === null && txRows === null) {
    throw new Error('This is not a DSi Wallet Excel file. It needs a "Projects", "Accounts" or "Transactions" sheet.');
  }

  // ----- projects -----
  const liveProj = (existing.projects || []).filter(p => !p.deleted);
  const projById = new Map(liveProj.map(p => [p.id, p]));
  const projMerged = new Map(liveProj.map(p => [p.id, p]));
  const projOut = [];
  let projNew = 0, projUpdated = 0;
  const seenProj = new Set();
  for (const r of projRows || []) {
    try {
      const name = text(r.name);
      if (!name) throw new Error('Name is required');
      if (seenProj.has(name.toLowerCase())) throw new Error(`"${name}" appears twice`);
      seenProj.add(name.toLowerCase());
      const cur = text(r.currency).toUpperCase();
      if (!CURRENCIES[cur]) throw new Error('Currency must be BHD, INR or USD');
      const id = text(r.id);
      const current = (UUID.test(id) && projById.get(id)) || [...projMerged.values()].find(p => p.name.toLowerCase() === name.toLowerCase());
      if (current) {
        if (current.currency !== cur && existing.accounts.some(a => !a.deleted && a.project_id === current.id)) {
          throw new Error(`Currency of "${current.name}" cannot change because it has accounts`);
        }
        const row = { ...current, name, currency: cur, deleted: false, updated_at: now, dirty: true };
        projMerged.set(row.id, row); projOut.push(row); projUpdated++;
      } else {
        const row = { id: UUID.test(id) ? id : newId(), name, currency: cur, deleted: false, updated_at: now, dirty: true };
        projMerged.set(row.id, row); projOut.push(row); projNew++;
      }
    } catch (err) { fail('Projects', r._row, err.message); }
  }
  const projectByName = new Map([...projMerged.values()].filter(p => !p.deleted).map(p => [p.name.toLowerCase(), p]));
  const defaultProject = cur => [...projectByName.values()].filter(p => p.currency === cur).sort((a, b) => a.name.localeCompare(b.name))[0];

  // ----- accounts -----
  const liveAcc = (existing.accounts || []).filter(a => !a.deleted);
  const accById = new Map(liveAcc.map(a => [a.id, a]));
  const accByName = new Map(liveAcc.map(a => [a.name.toLowerCase(), a]));
  const accMerged = new Map(liveAcc.map(a => [a.id, a]));
  const hasTx = id => (existing.txs || []).some(t => !t.deleted && (t.account_id === id || t.to_account_id === id));
  const seenNames = new Set();
  const accOut = [];
  let accNew = 0, accUpdated = 0;
  for (const r of accRows || []) {
    try {
      const name = text(r.name);
      if (!name) throw new Error('Name is required');
      if (seenNames.has(name.toLowerCase())) throw new Error(`"${name}" appears twice in the sheet`);
      seenNames.add(name.toLowerCase());
      const cur = text(r.currency).toUpperCase();
      if (!CURRENCIES[cur]) throw new Error('Currency must be BHD, INR or USD');
      let project = text(r.project) ? projectByName.get(text(r.project).toLowerCase()) : defaultProject(cur);
      if (!project) throw new Error(text(r.project) ? `Project "${text(r.project)}" was not found. Add it to the Projects sheet.` : `No ${cur} project exists. Add one to the Projects sheet.`);
      if (project.currency !== cur) throw new Error(`Account currency ${cur} does not match project ${project.name} (${project.currency})`);
      const opening = toMinor(text(r['opening balance']) === '' ? '0' : String(r['opening balance']), cur, true);
      // Older files have no Type column: keep what the account already is.
      const typed = text(r.type).toLowerCase();
      if (typed && !KINDS[typed]) throw new Error('Type must be Bank account, Cash, Credit card or Other');
      const existingKind = (UUID.test(text(r.id)) && accById.get(text(r.id))) || accByName.get(name.toLowerCase());
      const kind = typed ? KINDS[typed] : (existingKind?.kind || 'bank');
      const isCard = kind === 'card';
      const statement_day = isCard ? dayOrNull(r['statement day'], 'Statement day') : null;
      const due_day = isCard ? dayOrNull(r['due day'], 'Due day') : null;
      const credit_limit = isCard && text(r['credit limit']) !== '' ? toMinor(String(r['credit limit']), cur) : null;
      const id = text(r.id);
      const current = (UUID.test(id) && accById.get(id)) || accByName.get(name.toLowerCase());
      if (current) {
        if (current.currency !== cur && hasTx(current.id)) throw new Error(`Currency of "${current.name}" cannot change because it has transactions`);
        const row = { ...current, project_id: project.id, name, currency: cur, opening, kind, statement_day, due_day, credit_limit, deleted: false, updated_at: now, dirty: true };
        accMerged.set(current.id, row); accOut.push(row); accUpdated++;
      } else {
        const row = { id: UUID.test(id) ? id : newId(), project_id: project.id, name, currency: cur, opening, kind, statement_day, due_day, credit_limit, deleted: false, updated_at: now, dirty: true };
        accMerged.set(row.id, row); accOut.push(row); accNew++;
      }
    } catch (err) { fail('Accounts', r._row, err.message); }
  }
  const accountByName = new Map([...accMerged.values()].filter(a => !a.deleted).map(a => [a.name.toLowerCase(), a]));

  // ----- transactions -----
  const liveTx = new Map((existing.txs || []).filter(t => !t.deleted).map(t => [t.id, t]));
  const txOut = [];
  let txNew = 0, txUpdated = 0, possibleDuplicates = 0;
  for (const r of txRows || []) {
    try {
      const type = text(r.type).toLowerCase();
      if (!TYPES.includes(type)) throw new Error('Type must be Income, Expense or Transfer');
      const from = accountByName.get(text(r.account).toLowerCase());
      if (!from) throw new Error(`Account "${text(r.account)}" was not found. Add it to the Accounts sheet first.`);
      const cur = from.currency;
      if (text(r.currency) && text(r.currency).toUpperCase() !== cur) throw new Error(`Currency ${text(r.currency)} does not match account ${from.name} (${cur})`);
      const amount = toMinor(typeof r.amount === 'number' ? String(r.amount) : text(r.amount), cur);
      let to = null;
      if (type === 'transfer') {
        to = accountByName.get(text(r['to account']).toLowerCase());
        if (!to) throw new Error(`To account "${text(r['to account'])}" was not found`);
      }
      const id = text(r.id);
      const fee = text(r.fee) === '' ? 0 : toMinor(String(r.fee), cur);
      const received = type === 'transfer' && to && to.currency !== cur && text(r.received) !== ''
        ? toMinor(String(r.received), to.currency) : null;
      const t = {
        id: UUID.test(id) ? id : newId(),
        date: parseDate(r.date), type, amount,
        account_id: from.id, to_account_id: to ? to.id : null,
        category: text(r.category), note: text(r.note),
        fee: type === 'transfer' ? fee : 0, received,
        deleted: false, updated_at: now, dirty: true,
      };
      validateTx(t, [...accMerged.values()]);
      if (liveTx.has(t.id)) txUpdated++;
      else {
        txNew++;
        if (!UUID.test(id) && [...liveTx.values()].some(o => o.date === t.date && o.type === t.type && o.amount === t.amount &&
            o.account_id === t.account_id && (o.to_account_id || null) === (t.to_account_id || null))) possibleDuplicates++;
      }
      txOut.push(t);
    } catch (err) { fail('Transactions', r._row, err.message); }
  }

  return {
    projects: errors.length ? [] : projOut,
    accounts: errors.length ? [] : accOut,
    transactions: errors.length ? [] : txOut,
    errors,
    counts: { projNew, projUpdated, accNew, accUpdated, txNew, txUpdated, possibleDuplicates },
  };
}
