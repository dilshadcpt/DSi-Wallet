// One place for every calculation the screens need. Each figure comes from the old app's own rules
// (old-state.js rebuilds the old data; finance-math, advances, construction-funding, parties and loan-math do the work).
import { oldState } from './old-state.js';
import { dueRows, expenseAmount, cardBalance } from './finance-math.js';
import { advanceRows } from './advances.js';
import { fundingRows, validateFunding } from './construction-funding.js';
import { partyActivity } from './parties.js';
import { paymentSuggestion } from './loan-math.js';
import { oldLoan } from './loan-bridge.js';
import { CURRENCIES } from './core.js';

const toMinor = (v, cur) => Math.round(v * 10 ** (CURRENCIES[cur] ?? 2));
export const RECORD_STORES = ['advances', 'funding', 'parties', 'budgets', 'plans', 'statements'];

// Everything the old calculations need, from the stores as they are on this device.
export function snapshotOf(S) {
  return { projects: S.projects, accounts: S.accounts, txs: S.txs, loans: S.loans, advances: S.advances, funding: S.funding,
    parties: S.parties, budgets: S.budgets, plans: S.plans, statements: S.statements };
}

// Dues in minor units, earliest first. Overdue items stay until they are paid.
export function duesNow(S, today, days = 14, pid = 'all') {
  const st = oldState(snapshotOf(S));
  const rows = dueRows(st, today, days).filter(d => d.remaining > 0 && (pid === 'all' || d.project === pid));
  const projCur = new Map(S.projects.map(p => [p.id, p.currency]));
  return rows.map(d => {
    const cur = projCur.get(d.project) || d.currency;
    const dayGap = Math.round((Date.parse(d.date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
    return { id: d.id, kind: d.kind, ref: d.ref, project: d.project, name: d.name, date: d.date, days: dayGap, currency: cur,
      amount: toMinor(d.remaining, cur), overdue: dayGap < 0 };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

// Advances and loans given or taken: paid, received and balance, in minor units.
export function advanceViews(S, today) {
  const st = oldState(snapshotOf(S));
  return advanceRows(st, today).map(r => {
    const cur = S.projects.find(p => p.id === r.project)?.currency;
    return { id: r.id, name: r.name, kind: r.kind, project: r.project, currency: cur, dueDate: r.dueDate || '',
      paid: toMinor(r.paid, cur), received: toMinor(r.received, cur), balance: toMinor(r.balance, cur) };
  });
}

// Construction funding sources: expected, received, remaining and status.
export function fundingViews(S, today) {
  const st = oldState(snapshotOf(S));
  return fundingRows(st, today).map(r => {
    const cur = S.projects.find(p => p.id === r.project)?.currency;
    return { id: r.id, name: r.name, project: r.project, currency: cur, expected: toMinor(r.expected, cur),
      received: toMinor(r.received, cur), remaining: toMinor(r.remaining, cur), status: r.status, receipts: r.receipts };
  });
}

// Budget (planned) against what the project has spent, per project.
export function budgetViews(S, today, pid = 'all') {
  const st = oldState(snapshotOf(S));
  return S.projects.filter(p => !p.deleted && (pid === 'all' || p.id === pid)).map(p => {
    const planned = S.budgets.filter(b => !b.deleted && b.project === p.id).reduce((n, b) => n + b.amount, 0);
    const spent = toMinor(expenseAmount(st, p.id, '0001-01-01', today), p.currency);
    return { project: p.id, name: p.name, currency: p.currency, planned, spent, left: planned - spent,
      lines: S.budgets.filter(b => !b.deleted && b.project === p.id).map(b => ({ id: b.id, division: b.division, amount: b.amount })) };
  });
}

// Investment plans: deposits made into each plan.
export function planViews(S) {
  return S.plans.filter(p => !p.deleted).map(p => {
    const deposits = S.txs.filter(t => !t.deleted && t.plan_id === p.id && t.type === 'expense').reduce((n, t) => n + t.amount, 0);
    const count = S.txs.filter(t => !t.deleted && t.plan_id === p.id).length;
    return { id: p.id, name: p.name, project: p.project, currency: S.projects.find(x => x.id === p.project)?.currency, kind: p.kind,
      target: p.target, current: p.current, deposits, count };
  });
}

// Party totals: money in and out per party, for one currency.
export function partyViews(S, today) {
  const st = oldState(snapshotOf(S));
  const rows = new Map();
  // Grouped by party and currency: the same party name can hold money in two currencies.
  for (const e of partyActivity(st, today, 'All')) {
    const key = e.partyName + '|' + e.currency;
    const r = rows.get(key) || { name: e.partyName, currency: e.currency, debit: 0, credit: 0, count: 0 };
    r.debit += toMinor(e.debit, e.currency); r.credit += toMinor(e.credit, e.currency); r.count++;
    rows.set(key, r);
  }
  return [...rows.values()];
}

// Card balance (owed) per card, from the old card rules.
export function cardViews(S, today) {
  const st = oldState(snapshotOf(S));
  return st.extras.cards.map(c => {
    const cur = S.projects.find(p => p.id === c.project)?.currency;
    return { id: c.id, name: c.name, currency: cur, owed: toMinor(-cardBalance(st, c, today), cur) };
  });
}

// Split of one loan payment into interest and principal, following the old app's suggestion.
export function paymentSplitFor(S, loanId, dueDate, amountMinor) {
  const loan = S.loans.find(l => l.id === loanId);
  const cur = S.projects.find(p => p.id === loan?.project)?.currency;
  const st = oldState(snapshotOf(S));
  const sug = paymentSuggestion(st, oldLoan(loan, cur), dueDate, amountMinor / 10 ** CURRENCIES[cur]);
  return { principal: toMinor(sug.principal, cur), interest: toMinor(sug.interest, cur), configured: sug.configured };
}

// Checks a funding link before it is saved (the old app's own validator).
export function checkFunding(S, sources) {
  const st = oldState(snapshotOf(S));
  return validateFunding(sources.map(s => ({ ...s, expected: s.expected / 10 ** CURRENCIES[s.currency] })), st.projects, st.entries);
}

// ---------- Ledger: every movement of one record, with a running balance ----------
// Rules follow the old app: advance balance = opening + paid - received; party debit = paid, credit = received;
// card balance = statement amount less payments; funding remaining = expected less received; plan = deposits.
// `range` is { from, to } in YYYY-MM-DD. Rows outside the range only move the balance brought forward.
export function ledgerFor(S, type, id, range) {
  const live = S.txs.filter(t => !t.deleted);
  const curOfProject = pid => S.projects.find(p => p.id === pid)?.currency || 'BHD';
  let cur = 'BHD', opening = 0, title = '', items = [];
  const movement = (t, debitOnly) => ({ id: t.id, date: t.date, desc: [t.category, t.note].filter(Boolean).join(' · ') || t.type, t });

  if (type === 'advance') {
    const a = S.advances.find(x => x.id === id);
    if (!a) return null;
    cur = curOfProject(a.project); opening = a.opening; title = a.name;
    items = live.filter(t => t.advance_id === id).map(t => {
      const m = movement(t);
      return { ...m, debit: t.source_type === 'Advance received' ? 0 : t.amount, credit: t.source_type === 'Advance received' ? t.amount : 0, sign: t.source_type === 'Advance received' ? -1 : 1 };
    });
  } else if (type === 'party') {
    const p = S.parties.find(x => x.id === id);
    if (!p) return null;
    cur = p.currency; title = p.name;
    items = live.filter(t => t.party_id === id).map(t => {
      const m = movement(t);
      return { ...m, debit: t.type === 'expense' ? t.amount : 0, credit: t.type === 'income' ? t.amount : 0, sign: t.type === 'expense' ? 1 : -1 };
    });
  } else if (type === 'statement') {
    const st = S.statements.find(x => x.id === id);
    if (!st) return null;
    cur = S.accounts.find(a => a.id === st.card)?.currency || 'BHD';
    title = `Statement ${st.statementDate ? toDMYish(st.statementDate) : ''}, due ${toDMYish(st.dueDate)}`;
    items.push({ id: st.id, date: st.statementDate || st.dueDate, desc: 'Statement amount due', debit: st.amount, credit: 0, sign: 1, t: null });
    items.push(...live.filter(t => t.pay_kind === 'card' && t.pay_ref === id).map(t => ({ ...movement(t), debit: 0, credit: t.amount, sign: -1 })));
  } else if (type === 'funding') {
    const f = S.funding.find(x => x.id === id);
    if (!f) return null;
    cur = curOfProject(f.project); opening = f.expected; title = f.name;
    items = (f.receipts || []).map(r => {
      const t = S.txs.find(x => x.id === r.entry && !x.deleted);
      return { id: r.entry, date: t?.date || '', desc: t ? ([t.category, t.note].filter(Boolean).join(' · ') || 'Receipt') : 'Receipt (removed)', debit: 0, credit: r.amount, sign: -1, t };
    });
  } else if (type === 'plan') {
    const p = S.plans.find(x => x.id === id);
    if (!p) return null;
    cur = curOfProject(p.project); title = p.name;
    items = live.filter(t => t.plan_id === id).map(t => ({ ...movement(t), debit: t.amount, credit: 0, sign: 1 }));
  } else if (type === 'budget') {
    cur = curOfProject(id); title = S.projects.find(p => p.id === id)?.name || '';
    opening = S.budgets.filter(b => !b.deleted && b.project === id).reduce((n, b) => n + b.amount, 0);
    const accPid = new Map(S.accounts.map(a => [a.id, a.project_id]));
    // Same rule as the old app's spending: ordinary expenses, plus the interest part of loan repayments.
    const inProject = t => (t.project_id || accPid.get(t.account_id)) === id;
    items = live.filter(t => t.type === 'expense' && t.source_type === 'Expense' && inProject(t))
      .map(t => ({ ...movement(t), debit: t.amount, credit: 0, sign: 1 }))
      .concat(live.filter(t => t.pay_kind === 'loan' && t.interest > 0 && inProject(t))
        .map(t => ({ id: t.id, date: t.date, desc: 'Loan interest', debit: t.interest, credit: 0, sign: 1, t })));
  } else {
    return null;
  }

  items.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  let running = opening, bf = opening, dr = 0, cr = 0;
  const rows = [];
  for (const r of items) {
    if (type === 'funding') running -= r.credit;           // funding shows what is still to come
    else if (type === 'budget') running -= r.debit;        // budget shows what is left
    else running += r.sign * (r.debit + r.credit);
    if (r.date < range.from) { bf = running; continue; }
    if (r.date > range.to) continue;
    dr += r.debit; cr += r.credit;
    rows.push({ id: r.id, date: r.date, desc: r.desc, debit: r.debit, credit: r.credit, balance: running, t: r.t || null });
  }
  if (type === 'funding' || type === 'budget') {
    // Brought-forward figures for these are the amount left before the range.
    bf = rows.length ? rows[0].balance + (rows[0].credit || rows[0].debit) : opening;
  }
  const closing = rows.length ? rows[rows.length - 1].balance : bf;
  return { type, title, currency: cur, opening: bf, rows, totals: { debit: dr, credit: cr }, closing };
}

const toDMYish = iso => (iso ? iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4) : '');
