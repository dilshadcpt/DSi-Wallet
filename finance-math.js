import {loanSchedule} from './loan-math.js';
export const extras=s=>s.extras||{categories:[],cards:[],statements:[],charges:[],loans:[],budgets:[],payments:[]};
export function parseDate(value){if(typeof value!=='string')return '';value=value.trim();if(/^\d{4}-\d\d-\d\d$/.test(value))return value;const match=/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/.exec(value);if(!match)return value;let year=Number(match[3]);if(match[3].length===2)year+=2000;return `${year}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;}
export const displayDate=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\d$/.test(value)?value.slice(8)+'/'+value.slice(5,7)+'/'+value.slice(0,4):value;
export const daysBetween=(a,b)=>Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);
export function cardBalance(state,card,to='9999-12-31'){const x=extras(state),entries=new Map(state.entries.filter(e=>e.date<=to).map(e=>[e.id,e]));const ids=new Set([card.id,...x.statements.filter(s=>s.card===card.id).map(s=>s.id)]);const accountIds=new Set((x.accounts||[]).filter(a=>a.kind==='Credit card'&&a.card===card.id).map(a=>a.id));return card.opening+[...entries.values()].filter(e=>e.type==='Expense'&&accountIds.has(e.account)).reduce((s,e)=>s+e.amount,0)+x.charges.filter(c=>c.card===card.id&&c.date<=to).reduce((s,c)=>s+c.amount,0)-x.payments.filter(p=>p.kind==='card'&&ids.has(p.ref)).reduce((s,p)=>s+(entries.get(p.entry)?.amount||0),0);}
export function loanBalance(state,loan,to='9999-12-31'){const ids=new Set(state.entries.filter(e=>e.date<=to).map(e=>e.id));return Math.max(0,loan.opening+state.entries.filter(e=>e.type==='Loan receipt'&&e.loan===loan.id&&e.date<=to).reduce((s,e)=>s+e.amount,0)-extras(state).payments.filter(p=>p.kind==='loan'&&p.ref===loan.id&&ids.has(p.entry)).reduce((s,p)=>s+p.principal,0));}
export function expenseAmount(state,pid,from='0001-01-01',to='9999-12-31',category=''){const x=extras(state),inRange=e=>e.date>=from&&e.date<=to&&(!category||e.category.toLowerCase()===category.toLowerCase());const cardIds=new Set(x.cards.filter(c=>c.project===pid).map(c=>c.id)),entries=new Map(state.entries.map(e=>[e.id,e]));return state.entries.filter(e=>e.project===pid&&e.type==='Expense'&&inRange(e)).reduce((s,e)=>s+e.amount,0)+x.charges.filter(e=>(e.project||x.cards.find(c=>c.id===e.card)?.project)===pid&&inRange(e)).reduce((s,e)=>s+e.amount,0)+x.payments.filter(p=>p.kind==='loan'&&entries.get(p.entry)?.project===pid&&inRange({...entries.get(p.entry),category:'Loan interest'})).reduce((s,p)=>s+p.interest,0);}
export function dueRows(state,today,horizonDays=90){const x=extras(state),entries=new Map(state.entries.filter(e=>e.date<=today).map(e=>[e.id,e])),ps=new Map(state.projects.map(p=>[p.id,p]));const paid=(kind,ref,date)=>x.payments.filter(p=>p.kind===kind&&p.ref===ref&&(kind==='card'||p.dueDate===date)&&!entries.get(p.entry)?.loanAdjustment).reduce((sum,p)=>sum+(entries.get(p.entry)?.amount||0),0);const rows=[];
 for(const s of x.statements){const c=x.cards.find(c=>c.id===s.card),done=paid('card',s.id,s.dueDate);rows.push({id:s.id,kind:'card',ref:s.id,project:c.project,name:c.name,date:s.dueDate,amount:s.amount,paid:done,remaining:Math.max(0,s.amount-done),minimum:Math.max(0,s.minimum-done),currency:ps.get(c.project).currency});}
 for(const loan of x.loans){if(loan.mode==='manual')continue;if(loanBalance(state,loan,today)<=0.0005)continue;if(loan.interest){for(const item of loanSchedule(loan,ps.get(loan.project).currency,state).rows){if(daysBetween(today,item.date)>horizonDays)break;const done=paid('loan',loan.id,item.date);rows.push({id:loan.id+'_'+item.date,kind:'loan',ref:loan.id,project:loan.project,name:loan.name,date:item.date,amount:item.payment,paid:done,remaining:Math.max(0,item.payment-done),minimum:0,currency:ps.get(loan.project).currency});}continue;}const base=new Date(loan.firstDue+'T00:00:00Z'),now=new Date(today+'T00:00:00Z'),months=(now.getUTCFullYear()-base.getUTCFullYear())*12+now.getUTCMonth()-base.getUTCMonth()+Math.ceil(horizonDays/28)+1;for(let i=0;i<=Math.max(2,months);i++){if(i>1200)break;const d=new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth()+i,1)),last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(base.getUTCDate(),last));const date=d.toISOString().slice(0,10),done=paid('loan',loan.id,date);rows.push({id:loan.id+'_'+date,kind:'loan',ref:loan.id,project:loan.project,name:loan.name,date,amount:loan.emi,paid:done,remaining:Math.max(0,loan.emi-done),minimum:0,currency:ps.get(loan.project).currency});}}
 return rows.sort((a,b)=>a.date.localeCompare(b.date));}
export const reminderRows=(state,today)=>dueRows(state,today).filter(d=>d.remaining>0.0005&&daysBetween(today,d.date)<=7);
// Each journal row has one currency and one project; debits and credits balance per transaction.
export {buildJournal as journalRows} from './accounting.js';
export {accountAllocations,sharedAccountBalance,mergeAccounts,originalLoanAmount,adjustOriginalLoan,odReport,ledgerReport} from './accounting.js';

export {loanSchedule,actualLoanReport,paymentSuggestion,remainingLoanSchedule} from './loan-math.js';

export {debtImpact,removeDebt} from './debt-actions.js';

export {inflowAmount,validateFunding,fundingRows,availableFundingReceipt} from './construction-funding.js';

export {validateAdvances,advanceRows,loanPrincipalTotals} from './advances.js';

export {partyActivity,partyReport,constructionPartyRows} from './parties.js';

export {deleteUnusedOD} from './accounting.js';

export {odSummary} from './accounting.js';
