// Subsidiary party activity: posted payments/purchases and receipts, never extra postings.
const norm=s=>String(s||'').trim().toLowerCase();
const round=(n,c)=>Math.round((n+Number.EPSILON)*10**(c==='BHD'?3:2))/10**(c==='BHD'?3:2);
export function validateParties(rows,projects,entries,charges){
 const ids=new Set(),names=new Set(),pm=new Map(projects.map(p=>[p.id,p])),currencies=new Set(projects.map(p=>p.currency));
 const out=rows.map(r=>{const key=r.currency+'|'+norm(r.name);if(!r||typeof r.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(r.id)||ids.has(r.id)||typeof r.name!=='string'||!r.name.trim()||r.name.length>120||!currencies.has(r.currency)||names.has(key))throw Error('Party names must be unique in each currency.');ids.add(r.id);names.add(key);return {id:r.id,name:r.name.trim(),currency:r.currency};});
 const parties=new Map(out.map(p=>[p.id,p]));
 for(const e of [...entries,...charges])if(e.party!==undefined){const p=parties.get(e.party);if(!p||p.currency!==pm.get(e.project)?.currency||('type' in e&&!['Income','Expense'].includes(e.type)))throw Error('Select a party in the same currency for an income, expense or card purchase.');}
 return out;
}
export function partyActivity(s,to='9999-12-31',pid='All'){
 const pm=new Map(s.projects.map(p=>[p.id,p])),parties=new Map((s.extras?.parties||[]).map(p=>[p.id,p])),accounts=new Map((s.extras?.accounts||[]).map(a=>[a.id,a]));
 return [...s.entries.filter(e=>['Expense','Income'].includes(e.type)).map(e=>({...e,source:'entry',method:accounts.get(e.account)?.name||'Unassigned (legacy)'})),...(s.extras?.charges||[]).map(e=>({...e,source:'charge',type:'Expense',method:'Card · '+s.extras.cards.find(c=>c.id===e.card)?.name}))]
 .filter(e=>e.date<=to&&(pid==='All'||e.project===pid)).map(e=>({...e,currency:pm.get(e.project).currency,partyName:parties.get(e.party)?.name||'Unassigned party',debit:e.type==='Expense'?e.amount:0,credit:e.type==='Income'?e.amount:0})).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
}
export function partyReport(s,from,to,pid='All'){
 const rows=partyActivity(s,to,pid),scopeCurrency=s.projects.find(p=>p.id===pid)?.currency;
 return (s.extras?.parties||[]).filter(p=>!scopeCurrency||p.currency===scopeCurrency).map(p=>{const all=rows.filter(r=>r.party===p.id),opening=round(all.filter(r=>r.date<from).reduce((n,r)=>n+r.debit-r.credit,0),p.currency),current=all.filter(r=>r.date>=from);let balance=opening;const debit=round(current.reduce((n,r)=>n+r.debit,0),p.currency),credit=round(current.reduce((n,r)=>n+r.credit,0),p.currency);return {...p,opening,debit,credit,closing:round(opening+debit-credit,p.currency),rows:current.map(r=>({...r,balance:round(balance+=r.debit-r.credit,p.currency)}))};});
}
export function constructionPartyRows(s,to,pid='All'){
 const activity=partyActivity(s,to,pid).filter(e=>e.type==='Expense'),rows=[];
 for(const b of s.extras.budgets.filter(b=>pid==='All'||b.project===pid))for(const e of activity.filter(e=>e.project===b.project&&norm(e.category)===norm(b.division)))rows.push({...e,budget:b.id,division:b.division});
 return rows;
}
