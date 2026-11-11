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
