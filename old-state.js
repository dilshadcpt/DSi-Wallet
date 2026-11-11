// Rebuilds the old app's full data (in major units) from the new records, so the old app's own calculations
// (advances, construction funding, parties, dues, cards, investments) run on the same figures.
import { toPlain } from './core.js';
import { oldLoan } from './loan-bridge.js';

const major = (minor, cur) => Number(toPlain(minor ?? 0, cur));
const KIND = { bank: 'Bank', cash: 'Cash', od: 'OD', card: 'Credit card', other: 'Other' };

export function oldState(snap) {
  const live = arr => (arr || []).filter(x => !x.deleted);
  const projects = live(snap.projects);
  const accounts = live(snap.accounts);
  const accById = new Map(accounts.map(a => [a.id, a]));
  const curOf = id => accById.get(id)?.currency;

  const entries = (snap.txs || []).filter(t => !t.deleted).map(t => {
    const a = accById.get(t.account_id), c = a?.currency;
    const to = accById.get(t.to_account_id);
    const type = t.source_type || (t.type === 'income' ? 'Income' : t.type === 'expense' ? 'Expense' : 'Contra');
    const e = { id: t.id, date: t.date, type, project: t.project_id || a?.project_id, account: t.account_id, amount: major(t.amount, c), category: t.category || '', description: t.note || '' };
    if (t.type === 'transfer' && to && type !== 'Card payment') {
      e.toAccount = to.id; e.toProject = to.project_id;
      e.received = major(t.received ?? t.amount, to.currency); e.fee = major(t.fee || 0, c);
    }
    if (t.party_id) e.party = t.party_id;
    if (t.plan_id) e.plan = t.plan_id;
    if (t.advance_id) e.advance = t.advance_id;
    if (t.loan_id) e.loan = t.loan_id;
    if (t.adjustment) e.loanAdjustment = true;
    return e;
  });

  const oldAccounts = accounts.map(a => ({
    id: a.id, name: a.name, kind: KIND[a.kind] || 'Bank', project: a.project_id, opening: major(a.opening, a.currency),
    ...(a.od ? { od: { limit: major(a.od.limit, a.currency), rate: a.od.rate, basis: a.od.basis, start: a.od.start } } : {}),
    ...(a.card_ref ? { card: a.card_ref } : {}),
  }));
  const cards = accounts.filter(a => a.kind === 'card').map(a => ({
    id: a.card_ref || a.id, name: a.name.replace(/ \(card\)$/, ''), project: a.project_id,
    opening: -major(a.opening, a.currency), limit: a.credit_limit == null ? 0 : major(a.credit_limit, a.currency),
  }));
  const payments = (snap.txs || []).filter(t => !t.deleted && t.pay_kind).map(t => {
    const c = curOf(t.account_id);
    return { id: t.id, kind: t.pay_kind, ref: t.pay_ref, entry: t.id, dueDate: t.due_date, principal: major(t.principal, c), interest: major(t.interest, c) };
  });
  const statements = live(snap.statements).map(s => ({
    id: s.id, card: accById.get(s.card)?.card_ref || s.card, statementDate: s.statementDate, dueDate: s.dueDate,
    amount: major(s.amount, curOf(s.card)), minimum: major(s.minimum, curOf(s.card)),
  }));
  const pc = new Map(projects.map(p => [p.id, p.currency]));
  return {
    projects: projects.map(p => ({ id: p.id, name: p.name, currency: p.currency, openingDate: p.opening_date || '2000-01-01', opening: 0 })),
    rates: [],
    plans: live(snap.plans).map(p => ({ id: p.id, project: p.project, name: p.name, kind: p.kind, target: major(p.target, pc.get(p.project)), day: p.day, current: major(p.current, pc.get(p.project)), valuationDate: p.valuationDate })),
    entries,
    extras: {
      accounts: oldAccounts, cards, statements, charges: [], categories: [], budgets: live(snap.budgets).map(b => ({ id: b.id, project: b.project, division: b.division, amount: major(b.amount, pc.get(b.project)) })),
      loans: live(snap.loans).map(l => oldLoan(l, pc.get(l.project))), payments,
      funding: live(snap.funding).map(f => ({ id: f.id, project: f.project, name: f.name, expected: major(f.expected, pc.get(f.project)), expectedDate: f.expectedDate, notes: f.notes || '', receipts: (f.receipts || []).map(r => ({ entry: r.entry, amount: major(r.amount, pc.get(f.project)) })) })),
      advances: live(snap.advances).map(a => ({ id: a.id, project: a.project, name: a.name, kind: a.kind, opening: major(a.opening, pc.get(a.project)), dueDate: a.dueDate || undefined, notes: a.notes || '' })),
      parties: live(snap.parties).map(p => ({ id: p.id, name: p.name, currency: p.currency })),
    },
  };
}
