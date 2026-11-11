// Overdraft interest. The old app's own odReport rules (accounting.js, copied unchanged) run on the new records.
import { odReport } from './accounting.js';
import { toPlain } from './core.js';

const major = (minor, cur) => Number(toPlain(minor, cur));

// New records (minor units) -> old app state (major units). Only the fields the overdraft report reads are rebuilt.
export function oldAccountingState(projects, accounts, txs) {
  const cur = new Map(accounts.map(a => [a.id, a.currency]));
  const kindOf = t => {
    if (t.type === 'income') return t.category === 'Advance received' ? 'Advance received' : t.loan_id ? 'Loan receipt' : 'Income';
    if (t.type === 'expense') return t.category === 'Advance paid' ? 'Advance paid' : t.loan_id ? 'Loan repayment' : 'Expense';
    return t.to_account_id ? 'Contra' : 'Expense';
  };
  return {
    projects: projects.filter(p => !p.deleted).map(p => ({ id: p.id, name: p.name, currency: p.currency, openingDate: p.opening_date || '2000-01-01' })),
    extras: {
      accounts: accounts.filter(a => !a.deleted).map(a => {
        const c = a.currency;
        return {
          id: a.id, name: a.name, kind: a.kind === 'od' ? 'OD' : a.kind === 'card' ? 'Credit card' : a.kind === 'cash' ? 'Cash' : 'Bank',
          project: a.project_id, opening: major(a.opening, c),
          ...(a.od ? { od: { limit: major(a.od.limit, c), rate: a.od.rate, basis: a.od.basis, start: a.od.start } } : {}),
        };
      }),
    },
    entries: txs.filter(t => !t.deleted).map(t => {
      const c = cur.get(t.account_id);
      const project = accounts.find(a => a.id === t.account_id)?.project_id;
      return {
        id: t.id, date: t.date, type: kindOf(t), project, account: t.account_id,
        toAccount: t.to_account_id || undefined, toProject: t.to_account_id ? accounts.find(a => a.id === t.to_account_id)?.project_id : undefined,
        amount: major(t.amount, c), fee: 0, received: major(t.amount, c), category: t.category || '', description: t.note || '',
        loanAdjustment: !!t.adjustment,
      };
    }),
    _c: cur,
  };
}

export function overdraftView(acc, projects, accounts, txs, asOf) {
  const st = oldAccountingState(projects, accounts, txs);
  const oldAcc = st.extras.accounts.find(a => a.id === acc.id);
  const r = odReport(st, oldAcc, asOf);
  const cur = acc.currency;
  const minor = v => Math.round(v * 10 ** (cur === 'BHD' ? 3 : 2));
  return { used: minor(r.used), available: minor(r.available), interest: minor(r.interest), limit: minor(r.limit), balance: minor(r.balance), segments: r.segments };
}
