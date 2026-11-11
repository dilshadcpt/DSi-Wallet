// Builds the PDF reports. Uses the same balance rules as the app screens.
import { fmt, toPlain, balances, monthSummary } from './core.js';
import { toDMY } from './format.js';
import { Pdf } from './pdf.js';

const parts = ym => ym.split('-').map(Number);
const lastDay = ym => { const [y, m] = parts(ym); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const prevMonth = ym => { const [y, m] = parts(ym); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };
const monthLabel = ym => { const [y, m] = parts(ym); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const signed = (sign, minor, cur) => `${sign}${toPlain(minor, cur)}`;
const money = (minor, cur) => `${toPlain(minor, cur)}`;

// Monthly statement: summary per currency, each account, then every transaction in the month.
export function monthlyPdf({ accounts, txs, month, generated }) {
  const live = accounts.filter(a => !a.deleted);
  const pm = prevMonth(month);
  const openBal = balances(accounts, txs.filter(t => t.date <= lastDay(pm)));
  const closeBal = balances(accounts, txs.filter(t => t.date <= lastDay(month)));
  const inMonth = txs.filter(t => !t.deleted && t.date.startsWith(month));
  const summary = monthSummary(txs, accounts, month);
  const byId = new Map(accounts.map(a => [a.id, a]));
  const currencies = [...new Set(live.map(a => a.currency))].sort();

  const pdf = new Pdf({ title: `DSi Digital statement ${month}`, footer: `DSi Digital · Statement for ${monthLabel(month)} · Generated ${toDMY(generated)}` });
  pdf.titleBlock('Monthly statement', monthLabel(month));

  pdf.heading('Summary by currency');
  pdf.setHeader([{ x: L0, t: 'Currency' }, { x: 150, t: 'Opening', align: 'right' }, { x: 260, t: 'Income', align: 'right' }, { x: 370, t: 'Expenses', align: 'right' }, { x: R0, t: 'Closing', align: 'right' }]);
  for (const c of currencies) {
    const sumOpen = live.filter(a => a.currency === c).reduce((n, a) => n + (openBal.get(a.id) || 0), 0);
    const sumClose = live.filter(a => a.currency === c).reduce((n, a) => n + (closeBal.get(a.id) || 0), 0);
    const s = summary[c] || { income: 0, expense: 0 };
    pdf.row([
      { x: L0, t: c, bold: true }, { x: 150, t: money(sumOpen, c), align: 'right' },
      { x: 260, t: money(s.income, c), align: 'right' }, { x: 370, t: money(s.expense, c), align: 'right' },
      { x: R0, t: money(sumClose, c), align: 'right', bold: true },
    ]);
  }
  if (!currencies.length) pdf.row([{ x: L0, t: 'No accounts yet.' }]);

  pdf.gap(10);
  pdf.heading('Accounts');
  pdf.setHeader([{ x: L0, t: 'Account' }, { x: 230, t: 'Currency' }, { x: 300, t: 'Opening', align: 'right' }, { x: 410, t: 'Net movement', align: 'right' }, { x: R0, t: 'Closing', align: 'right' }]);
  for (const a of live) {
    const net = (closeBal.get(a.id) || 0) - (openBal.get(a.id) || 0);
    pdf.row([
      { x: L0, t: truncate(a.name, 30) }, { x: 230, t: a.currency },
      { x: 300, t: money(openBal.get(a.id) || 0, a.currency), align: 'right' },
      { x: 410, t: signed(net < 0 ? '-' : '+', Math.abs(net), a.currency), align: 'right' },
      { x: R0, t: money(closeBal.get(a.id) || 0, a.currency), align: 'right', bold: true },
    ]);
  }

  pdf.gap(10);
  pdf.heading(`Transactions (${inMonth.length})`);
  pdf.setHeader([{ x: L0, t: 'Date' }, { x: 110, t: 'Type' }, { x: 170, t: 'Details' }, { x: 380, t: 'Account' }, { x: R0, t: 'Amount', align: 'right' }]);
  if (!inMonth.length) pdf.row([{ x: L0, t: 'No transactions this month.' }]);
  for (const t of [...inMonth].sort((a, b) => a.date.localeCompare(b.date) || a.updated_at - b.updated_at)) {
    const a = byId.get(t.account_id), to = byId.get(t.to_account_id);
    const cur = a?.currency || '';
    const type = t.type === 'income' ? 'Income' : t.type === 'expense' ? 'Expense' : 'Transfer';
    const details = t.type === 'transfer' ? `To ${to?.name || '?'}` : (t.category || '') + (t.note ? ' - ' + t.note : '');
    const amt = t.type === 'income' ? signed('+', t.amount, cur) : t.type === 'expense' ? signed('-', t.amount, cur) : money(t.amount, cur);
    pdf.row([
      { x: L0, t: toDMY(t.date) }, { x: 110, t: type }, { x: 170, t: truncate(details, 34) },
      { x: 380, t: truncate(a?.name || '', 16) }, { x: R0, t: `${amt} ${cur}`, align: 'right' },
    ]);
  }
  return pdf.build();
}

// Account statement: opening balance, every movement in the range, running balance.
export function accountPdf({ accounts, txs, accountId, from, to, generated }) {
  const acc = accounts.find(a => a.id === accountId);
  const cur = acc.currency;
  const byId = new Map(accounts.map(a => [a.id, a]));
  const start = balances(accounts, txs.filter(t => t.date < from)).get(accountId) || 0;
  const rows = txs.filter(t => !t.deleted && t.date >= from && t.date <= to &&
      (t.account_id === accountId || t.to_account_id === accountId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.updated_at - b.updated_at);

  const pdf = new Pdf({ title: `DSi Digital statement ${acc.name} ${toDMY(from)} to ${toDMY(to)}`, footer: `DSi Digital · ${acc.name} · Generated ${toDMY(generated)}` });
  pdf.titleBlock('Account statement', `${acc.name} (${cur})  ·  ${toDMY(from)} to ${toDMY(to)}`);
  pdf.row([{ x: L0, t: `Opening balance on ${toDMY(from)}`, bold: true }, { x: R0, t: `${money(start, cur)} ${cur}`, align: 'right', bold: true }]);
  pdf.gap(4);
  pdf.setHeader([{ x: L0, t: 'Date' }, { x: 100, t: 'Description' }, { x: 370, t: 'Money out', align: 'right' }, { x: 450, t: 'Money in', align: 'right' }, { x: R0, t: 'Balance', align: 'right' }]);

  let bal = start, totalIn = 0, totalOut = 0;
  if (!rows.length) pdf.row([{ x: L0, t: 'No movements in this period.' }]);
  for (const t of rows) {
    let out = 0, inn = 0, desc;
    if (t.type === 'income' && t.account_id === accountId) { inn = t.amount; desc = t.category || 'Income'; }
    else if (t.type === 'expense' && t.account_id === accountId) { out = t.amount; desc = t.category || 'Expense'; }
    else if (t.type === 'transfer' && t.account_id === accountId) { out = t.amount; desc = `Transfer to ${byId.get(t.to_account_id)?.name || '?'}`; }
    else if (t.type === 'transfer' && t.to_account_id === accountId) { inn = t.amount; desc = `Transfer from ${byId.get(t.account_id)?.name || '?'}`; }
    else continue;
    if (t.note) desc += ' - ' + t.note;
    bal += inn - out; totalIn += inn; totalOut += out;
    pdf.row([
      { x: L0, t: toDMY(t.date) }, { x: 100, t: truncate(desc, 44) },
      { x: 370, t: out ? money(out, cur) : '', align: 'right' },
      { x: 450, t: inn ? money(inn, cur) : '', align: 'right' },
      { x: R0, t: money(bal, cur), align: 'right' },
    ]);
  }
  pdf.gap(6);
  pdf.rule();
  pdf.row([{ x: L0, t: 'Totals for period', bold: true }, { x: 370, t: money(totalOut, cur), align: 'right', bold: true }, { x: 450, t: money(totalIn, cur), align: 'right', bold: true }]);
  pdf.row([{ x: L0, t: `Closing balance on ${toDMY(to)}`, bold: true }, { x: R0, t: `${money(bal, cur)} ${cur}`, align: 'right', bold: true }]);
  return pdf.build();
}

const L0 = 40, R0 = 555;
const truncate = (s, n) => { const v = String(s ?? ''); return v.length > n ? v.slice(0, n - 2) + '..' : v; };
