// Loan calculations. The schedule and balance rules are the old app's own (loan-math.js, copied unchanged).
// This bridge rebuilds the old app's view of the data from the new records, so the same rules produce the same figures.
import { loanSchedule, actualLoanReport, remainingLoanSchedule } from './loan-math.js';
import { toPlain, CURRENCIES } from './core.js';

const major = (minor, cur) => Number(toPlain(minor, cur));

// New records (minor units) -> old engine state (major units).
export function oldState(projects, txs) {
  const cur = new Map(projects.map(p => [p.id, p.currency]));
  return {
    projects: projects.filter(p => !p.deleted).map(p => ({ id: p.id, currency: p.currency, openingDate: p.opening_date || '2000-01-01', name: p.name })),
    entries: txs.filter(t => !t.deleted && t.loan_id).map(t => ({
      id: t.id, date: t.date, type: t.type === 'income' ? 'Loan receipt' : 'Loan repayment', loan: t.loan_id,
      amount: major(t.amount, t._currency), loanAdjustment: !!t.adjustment,
    })),
    extras: {
      payments: txs.filter(t => !t.deleted && t.loan_id && t.type === 'expense' && t.principal != null).map(t => ({
        id: t.id, kind: 'loan', ref: t.loan_id, entry: t.id, dueDate: t.due_date,
        principal: major(t.principal, t._currency), interest: major(t.interest, t._currency),
      })),
    },
    _cur: cur,
  };
}

// One loan record (minor units) -> the old engine's loan object (major units).
export function oldLoan(l, currency) {
  const m = v => (v == null ? v : major(v, currency));
  const o = { ...l, opening: m(l.opening) || 0, emi: m(l.emi) || 0 };
  if (l.projection) {
    o.projection = {
      ...l.projection, opening: m(l.projection.opening) || 0, emi: m(l.projection.emi) || 0,
      draws: (l.projection.draws || []).map(d => ({ ...d, amount: m(d.amount) })),
    };
  }
  return o;
}

// Full picture for one loan, as of a date. Same fields the old app shows.
export function loanView(loan, projects, txs, asOf) {
  const cur = projects.find(p => p.id === loan.project)?.currency;
  const mine = txs.filter(t => t.loan_id === loan.id).map(t => ({ ...t, _currency: cur }));
  const st = oldState(projects, mine);
  const old = oldLoan(loan, cur);
  const actual = actualLoanReport(st, old, asOf);
  const schedule = loanSchedule(old, cur, st);
  const remaining = remainingLoanSchedule(st, old, asOf);
  const minor = v => (v == null ? null : Math.round(v * 10 ** CURRENCIES[cur]));
  return {
    currency: cur,
    principal: minor(actual.principal),
    accrued: actual.accrued == null ? null : minor(actual.accrued),
    paidInterest: minor(actual.paidInterest),
    unpaidInterest: actual.unpaidInterest == null ? null : minor(actual.unpaidInterest),
    scheduleRows: schedule.rows.length,
    firstRow: schedule.rows[0] || null,
    lastRow: schedule.rows.at(-1) || null,
    remainingRows: remaining.rows.length,
    remainingFirst: remaining.rows[0] || null,
    reason: schedule.reason || '',
    schedule: schedule.rows,
    remaining: remaining.rows,
  };
}
