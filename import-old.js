// Converts a DSi Finance App (2.0.x) backup into DSi Wallet records.
// Every old entry becomes one transaction that keeps the old entry type (source_type), so the old app's
// calculations can run on the same data. Re-importing the same file gives the same IDs (no duplicates).
import { CURRENCIES, validateTx } from './core.js';

const dec = c => CURRENCIES[c] ?? 2;
const toMinorOld = (v, c) => Math.round((Number(v || 0) + Number.EPSILON) * 10 ** dec(c));

export async function uuidFor(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dsi-old-import:' + key));
  const b = new Uint8Array(digest).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function convertOldBackup(text, { now = Date.now() } = {}) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('This file is not a valid backup.'); }
  const state = doc && doc.state && typeof doc.state === 'object' ? doc.state : doc;
  if (!state || !Array.isArray(state.projects) || !Array.isArray(state.entries)) {
    throw new Error('This is not a DSi Finance App backup. Choose a DSiFinance_… .json file.');
  }
  const ex = state.extras || {};
  const list = k => (Array.isArray(ex[k]) ? ex[k] : []);
  const projects = new Map(state.projects.map(p => [p.id, p]));
  const cards = new Map(list('cards').map(c => [c.id, c]));
  const parties = new Map(list('parties').map(p => [p.id, p.name]));
  const loans = new Map(list('loans').map(l => [l.id, l.name]));
  const advances = new Map(list('advances').map(a => [a.id, a.name]));
  const plans = new Map((state.plans || []).map(p => [p.id, p.name]));
  const statements = new Map(list('statements').map(s => [s.id, s]));
  const payments = list('payments');
  const oldAccounts = list('accounts');

  const report = { projects: 0, accounts: 0, transactions: 0, byType: {}, skipped: [], notes: [], ignored: {} };
  const accounts = [], transactions = [];
  const allocs = a => (Array.isArray(a.allocations) && a.allocations.length ? a.allocations : [{ project: a.project, amount: a.opening }]);

  // Cash that belongs to a project but to no account (old "Unassigned" cash).
  const restOf = new Map();
  for (const p of state.projects) {
    const allocated = oldAccounts.filter(a => a.kind !== 'Credit card').flatMap(allocs)
      .filter(r => r.project === p.id).reduce((n, r) => n + Number(r.amount || 0), 0);
    restOf.set(p.id, Number(p.opening || 0) - allocated);
  }

  // ----- projects -----
  const projRow = new Map();
  for (const p of state.projects) {
    projRow.set(p.id, { id: await uuidFor('proj:' + p.id), name: p.name, currency: p.currency, opening_date: p.openingDate || '2000-01-01', updated_at: now, deleted: false, dirty: true });
  }
  const projectRows = [...projRow.values()];
  const projId = pid => projRow.get(pid)?.id;

  // ----- records that transactions point to -----
  const mn = (v, cur) => (v == null ? v : toMinorOld(v, cur));
  const rec = async (table, key, row) => ({ id: await uuidFor(table + ':' + key), ...row, deleted: false, updated_at: now, dirty: true });
  const partyRows = [];
  for (const p of list('parties')) partyRows.push(await rec('party', p.id, { name: p.name, currency: p.currency }));
  const partyId = new Map(partyRows.map((r, i) => [list('parties')[i].id, r.id]));

  const advanceRows = [];
  for (const a of list('advances')) {
    const p = projRow.get(a.project);
    if (!p) continue;
    advanceRows.push(await rec('advance', a.id, { project: p.id, name: a.name, kind: a.kind, opening: mn(a.opening, p.currency), dueDate: a.dueDate || null, notes: a.notes || '' }));
  }
  const advanceId = new Map(advanceRows.map((r, i) => [list('advances').filter(a => projRow.get(a.project))[i].id, r.id]));

  const budgetRows = [];
  for (const b of list('budgets')) {
    const p = projRow.get(b.project);
    if (p) budgetRows.push(await rec('budget', b.id, { project: p.id, division: b.division, amount: mn(b.amount, p.currency) }));
  }

  const planRows = new Map();
  for (const pl of state.plans || []) {
    const p = projRow.get(pl.project);
    if (!p) continue;
    planRows.set(pl.id, await rec('plan', pl.id, { project: p.id, name: pl.name, kind: pl.kind || null, target: mn(pl.target, p.currency) || 0, day: pl.day ?? null, current: mn(pl.current, p.currency) || 0, valuationDate: pl.valuationDate || null }));
  }

  // Loans keep the old app's own fields (EMI, rate, schedule settings), amounts in minor units.
  const loanRows = new Map();
  for (const l of list('loans')) {
    const p = projRow.get(l.project);
    if (!p) continue;
    const cur = p.currency;
    const projection = l.projection ? {
      ...l.projection, opening: mn(l.projection.opening, cur) || 0, emi: mn(l.projection.emi, cur) || 0,
      draws: (l.projection.draws || []).map(d => ({ ...d, amount: mn(d.amount, cur) })),
    } : undefined;
    loanRows.set(l.id, {
      ...l, id: await uuidFor('loan:' + l.id), project: p.id, opening: mn(l.opening, cur) || 0, emi: mn(l.emi, cur) || 0,
      ...(projection ? { projection } : {}), deleted: false, updated_at: now, dirty: true,
    });
  }
  const payByEntry = new Map(payments.map(x => [x.entry, x]));

  const makeAccount = async (key, name, currency, opening, projectId) => {
    const row = { id: await uuidFor('acc:' + key), project_id: projectId, name, currency, opening, kind: 'bank', deleted: false, updated_at: now, dirty: true };
    accounts.push(row);
    return row;
  };

  // Card settings for the new app: payment due day and statement day from the newest statement, and the limit.
  const cardFields = (cardId, cur) => {
    const card = cards.get(cardId) || {};
    const sts = list('statements').filter(x => x.card === cardId).sort((x, y) => String(x.statementDate).localeCompare(String(y.statementDate)));
    const last = sts[sts.length - 1];
    return {
      kind: 'card',
      statement_day: last ? Number(String(last.statementDate).slice(8, 10)) : null,
      due_day: last ? Number(String(last.dueDate).slice(8, 10)) : null,
      credit_limit: card.limit ? toMinorOld(card.limit, cur) : null,
    };
  };

  // ----- accounts -----
  const accMap = new Map(), cardAcc = new Map(), unassigned = new Map();
  for (const a of oldAccounts) {
    const p = projects.get(a.project);
    if (!p) { report.skipped.push(`Account "${a.name}": its project is missing`); continue; }
    const cur = p.currency;
    const opening = a.kind === 'Credit card'
      ? -toMinorOld(cards.get(a.card)?.opening || 0, cur)
      : toMinorOld(allocs(a).reduce((n, r) => n + Number(r.amount || 0), 0), cur);
    const row = await makeAccount('old:' + a.id, a.name, cur, opening, projId(p.id));
    accMap.set(a.id, row);
    if (a.kind === 'Credit card' && a.card) {
      cardAcc.set(a.card, row);
      Object.assign(row, cardFields(a.card, cur), { card_ref: a.card });
    } else {
      row.kind = { Bank: 'bank', Cash: 'cash', OD: 'od', Other: 'other' }[a.kind] || 'bank';
    }
    if (a.od) row.od = { limit: toMinorOld(a.od.limit, cur), rate: a.od.rate, basis: a.od.basis, start: a.od.start };
  }
  for (const c of list('cards')) {
    if (cardAcc.has(c.id)) continue;
    const p = projects.get(c.project);
    if (!p) { report.skipped.push(`Card "${c.name}": its project is missing`); continue; }
    const row = await makeAccount('card:' + c.id, `${c.name} (card)`, p.currency, -toMinorOld(c.opening || 0, p.currency), projId(p.id));
    Object.assign(row, cardFields(c.id, p.currency), { card_ref: c.id });
    cardAcc.set(c.id, row);
  }
  const unassignedFor = async pid => {
    if (!unassigned.has(pid)) {
      const p = projects.get(pid);
      unassigned.set(pid, await makeAccount('unassigned:' + pid, 'Unassigned cash', p.currency, toMinorOld(restOf.get(pid), p.currency), projId(pid)));
    }
    return unassigned.get(pid);
  };
  const accountFor = async (oldId, pid) => (oldId && accMap.get(oldId)) || unassignedFor(pid);
  for (const p of state.projects) if (restOf.get(p.id) !== 0) await unassignedFor(p.id);

  // Statements (card bills) and funding sources, now that accounts exist.
  const statementRows = [];
  for (const s of list('statements')) {
    const card = cardAcc.get(s.card);
    if (!card) continue;
    statementRows.push(await rec('statement', s.id, { card: card.id, statementDate: s.statementDate, dueDate: s.dueDate, amount: mn(s.amount, card.currency), minimum: mn(s.minimum, card.currency) || 0 }));
  }
  const statementId = new Map(list('statements').map((s, i) => [s.id, statementRows.find(r => r.statementDate === s.statementDate && r.dueDate === s.dueDate && r.card === cardAcc.get(s.card)?.id)?.id]));

  // ----- transactions: one per old entry -----
  const put = async (key, e, fields) => {
    if (!(fields.amount > 0)) return;
    const acc = fields.account;
    const t = {
      id: await uuidFor('tx:' + key), date: e.date, type: fields.type, amount: fields.amount,
      account_id: acc.id, to_account_id: fields.toAccount ? fields.toAccount.id : null,
      category: fields.category || '', note: fields.note || '',
      source_type: e.type, fee: fields.fee || 0, received: fields.received ?? null, project_id: projId(e.project) || null,
      party_id: e.party ? partyId.get(e.party) || null : null,
      advance_id: e.advance ? advanceId.get(e.advance) || null : null,
      plan_id: e.plan ? planRows.get(e.plan)?.id || null : null,
      loan_id: fields.loan_id || null, adjustment: !!e.loanAdjustment,
      principal: fields.principal ?? null, interest: fields.interest ?? null, due_date: fields.due_date || null,
      pay_kind: fields.pay_kind || null, pay_ref: fields.pay_ref || null,
      deleted: false, updated_at: now, dirty: true,
    };
    if (t.to_account_id === null) delete t.received;
    validateTx(t, accounts);
    transactions.push(t);
    report.byType[t.type] = (report.byType[t.type] || 0) + 1;
    return t;
  };
  const join = (...parts) => parts.filter(Boolean).join(' · ');

  const entries = [...state.entries].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const e of entries) {
    try {
      const p = projects.get(e.project);
      if (!p) { report.skipped.push(`Entry ${e.id} (${e.date}): project missing`); continue; }
      const cur = p.currency, amt = toMinorOld(e.amount, cur);
      const party = e.party ? parties.get(e.party) : '';
      const src = await accountFor(e.account, e.project);
      const note = join(party, e.description);
      const base = { account: src, amount: amt, note };

      switch (e.type) {
        case 'Income':
          await put(e.id, e, { ...base, type: 'income', category: e.category || 'Income' }); break;
        case 'Expense':
          await put(e.id, e, { ...base, type: 'expense', category: e.category || 'Expense' }); break;
        case 'Investment':
          await put(e.id, e, { ...base, type: 'expense', category: 'Investment', note: join(plans.get(e.plan), e.description) }); break;
        case 'Loan receipt':
          await put(e.id, e, { ...base, type: 'income', category: 'Loan received', note: e.description || loans.get(e.loan),
            loan_id: loanRows.get(e.loan)?.id || null }); break;
        case 'Loan repayment': {
          const pay = payByEntry.get(e.id);
          if (!pay) report.notes.push(`Loan repayment ${e.date}: no principal and interest split found in the backup.`);
          const loanId = e.loan || pay?.ref;
          await put(e.id, e, { ...base, type: 'expense', category: 'Loan repayment', note: e.description || loans.get(loanId),
            loan_id: loanRows.get(loanId)?.id || null,
            principal: pay ? toMinorOld(pay.principal, cur) : null, interest: pay ? toMinorOld(pay.interest, cur) : null,
            due_date: pay?.dueDate || null, pay_kind: pay ? 'loan' : null, pay_ref: loanRows.get(loanId)?.id || null }); break;
        }
        case 'Advance paid':
          await put(e.id, e, { ...base, type: 'expense', category: 'Advance paid', note: join(advances.get(e.advance), e.description) }); break;
        case 'Advance received':
          await put(e.id, e, { ...base, type: 'income', category: 'Advance received', note: join(advances.get(e.advance), e.description) }); break;
        case 'Contra': {
          const dest = await accountFor(e.toAccount, e.project);
          await put(e.id, e, { ...base, type: 'transfer', toAccount: dest, category: 'Transfer', note }); break;
        }
        case 'Transfer': {
          const destPid = e.toProject || e.project;
          const destP = projects.get(destPid);
          if (!destP) { report.skipped.push(`Transfer ${e.id}: destination project missing`); break; }
          const dest = await accountFor(e.toAccount, destPid);
          const fee = toMinorOld(e.fee || 0, cur);
          const received = destP.currency === cur ? null : toMinorOld(e.received, destP.currency);
          await put(e.id, e, { ...base, type: 'transfer', toAccount: dest, category: 'Transfer', note, fee, received }); break;
        }
        case 'Card payment': {
          const pay = payByEntry.get(e.id);
          const st = pay && statements.get(pay.ref);
          const target = cardAcc.get(st?.card || pay?.ref);
          const common = { ...base, note, principal: pay ? toMinorOld(pay.principal, cur) : null, interest: pay ? toMinorOld(pay.interest, cur) : null, due_date: pay?.dueDate || null, pay_kind: pay ? 'card' : null, pay_ref: pay ? statementId.get(pay.ref) || pay.ref : null };
          if (target) await put(e.id, e, { ...common, type: 'transfer', toAccount: target, category: 'Card payment' });
          else await put(e.id, e, { ...common, type: 'expense', category: 'Card payment' });
          break;
        }
        default:
          report.skipped.push(`Entry ${e.id} (${e.date}): type "${e.type}" is not supported`);
      }
    } catch (err) {
      report.skipped.push(`Entry ${e.id} (${e.date}): ${err.message}`);
    }
  }

  for (const c of list('charges')) {
    try {
      const acc = cardAcc.get(c.card);
      const p = projects.get(c.project || cards.get(c.card)?.project);
      if (!acc || !p) { report.skipped.push(`Card purchase ${c.id}: card or project missing`); continue; }
      await put('charge:' + c.id, { date: c.date, type: 'Expense', party: c.party }, { account: acc, type: 'expense', amount: toMinorOld(c.amount, p.currency), category: c.category || 'Card purchase', note: c.description || '', party_id: null });
    } catch (err) {
      report.skipped.push(`Card purchase ${c.id}: ${err.message}`);
    }
  }

  report.accounts = accounts.length;
  report.projects = projectRows.length;
  report.transactions = transactions.length;
  report.cards = accounts.filter(a => a.kind === 'card').length;
  report.counts = { loans: loanRows.size, advances: advanceRows.length, parties: partyRows.length, budgets: budgetRows.length, plans: planRows.size, statements: statementRows.length, funding: list('funding').length };
  report.ignored = {};
  report.notes = [
    'Old projects are imported as project books, with their own currency and accounts.',
    'Loans keep their EMI, rate and payment split, so schedules and balances use the old app\'s rules.',
    'Transfers between currencies are kept as one transfer with the amount received.',
  ];
  return {
    projects: projectRows, accounts, transactions,
    loans: [...loanRows.values()], advances: advanceRows, parties: partyRows, budgets: budgetRows,
    plans: [...planRows.values()], statements: statementRows,
    funding: await Promise.all(list('funding').filter(f => projRow.get(f.project)).map(async f => ({
      id: await uuidFor('funding:' + f.id), project: projRow.get(f.project).id, name: f.name, expected: mn(f.expected, projRow.get(f.project).currency),
      expectedDate: f.expectedDate || null, notes: f.notes || '',
      // Receipts point at the new transaction IDs of the entries they came from.
      receipts: await Promise.all((f.receipts || []).map(async r => ({ entry: await uuidFor('tx:' + r.entry), amount: mn(r.amount, projRow.get(f.project).currency) }))),
      deleted: false, updated_at: now, dirty: true,
    }))),
    report,
  };
}
