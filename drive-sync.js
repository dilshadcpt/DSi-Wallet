// Google Drive sync. Your data is kept in the app's hidden Drive folder (drive.appdata), the same place the old app used.
// A small dues file is kept in a visible folder "DSi Wallet" so the Gmail reminder script can read it.
// Sign-in uses Google Identity Services. The app never sees your Google password.
import { normalize, mergeRemote, makeBackup } from './core.js';

export const SCOPES = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
export const DATA_FILE = 'dsi-wallet-data.json';
export const DUES_FILE = 'dues.json';
export const DUES_FOLDER = 'DSi Wallet';
export const SUBS_FILE = 'subscriptions.json';
export const TABLES = ['projects', 'accounts', 'loans', 'advances', 'funding', 'parties', 'budgets', 'plans', 'statements', 'transactions'];

// Merges two copies of one table: newer updated_at wins per record. Deleted records stay as tombstones.
export function mergeTable(table, localRows, remoteRows) {
  const byId = new Map(localRows.map(r => [r.id, { ...r, dirty: false }]));
  for (const raw of remoteRows || []) {
    const row = normalize(table, raw);
    const keep = mergeRemote(byId.get(row.id), row);
    if (keep) byId.set(row.id, keep);
  }
  return [...byId.values()];
}

// Merges the whole local state with the copy in Drive. Returns the merged state and the backup to save.
export function mergeState(local, remote) {
  const merged = {};
  for (const t of TABLES) merged[t] = mergeTable(t, local[t] || [], remote?.[t] || []);
  const more = Object.fromEntries(['advances', 'funding', 'parties', 'budgets', 'plans', 'statements'].map(k => [k, merged[k]]));
  const backup = makeBackup(merged.accounts, merged.transactions, merged.projects, merged.loans, more);
  return { state: merged, backup };
}

// Dues in a form the reminder script can read: grouped per loan or card, with the text to show.
export function duesFile(dues, fmt, today) {
  const groups = new Map();
  for (const d of dues) {
    const key = d.kind + '|' + d.ref;
    const g = groups.get(key) || { name: d.name, kind: d.kind, currency: d.currency, total: 0, count: 0, overdue: 0, date: d.date, days: d.days };
    g.total += d.amount; g.count++;
    if (d.overdue) g.overdue++;
    if (d.date < g.date) g.date = d.date;
    if (d.days < g.days) g.days = d.days;
    groups.set(key, g);
  }
  return {
    updated: today,
    items: [...groups.values()].map(g => ({
      name: g.name, kind: g.kind, date: g.date, days: g.days, overdue: g.overdue > 0,
      count: g.count, amountText: fmt(g.total, g.currency),
    })).sort((a, b) => a.days - b.days),
  };
}

// Thin Drive API client. `token` comes from Google Identity Services.
export function driveClient(token, fetchImpl = fetch) {
  const auth = { Authorization: 'Bearer ' + token };
  const api = async (url, opts = {}) => {
    const res = await fetchImpl(url, { ...opts, headers: { ...auth, ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`Google Drive ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return res;
  };
  const find = async (name, space, parent) => {
    const q = [`name='${name.replace(/'/g, "\\'")}'`, 'trashed=false'];
    if (parent) q.push(`'${parent}' in parents`);
    const res = await api(`https://www.googleapis.com/drive/v3/files?spaces=${space}&q=${encodeURIComponent(q.join(' and '))}&fields=files(id,name)`);
    return (await res.json()).files?.[0] || null;
  };
  const writeJson = async (name, space, parent, obj) => {
    const body = JSON.stringify(obj);
    const existing = await find(name, space, parent);
    if (existing) {
      await api(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
      });
      return existing.id;
    }
    const boundary = 'dsiwallet' + Date.now();
    const meta = { name, parents: [parent || 'appDataFolder'] };
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const res = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
    });
    return (await res.json()).id;
  };
  const readJson = async (name, space, parent) => {
    const f = await find(name, space, parent);
    if (!f) return null;
    return (await api(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`)).json();
  };
  const folder = async name => {
    const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const res = await api(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
    const hit = (await res.json()).files?.[0];
    if (hit) return hit.id;
    const created = await api('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
    });
    return (await created.json()).id;
  };
  return {
    readData: () => readJson(DATA_FILE, 'appDataFolder'),
    writeData: obj => writeJson(DATA_FILE, 'appDataFolder', null, obj),
    writeDues: async obj => writeJson(DUES_FILE, 'drive', await folder(DUES_FOLDER), obj),
    readSubs: async () => (await readJson(SUBS_FILE, 'drive', await folder(DUES_FOLDER))) || [],
    writeSubs: async list => writeJson(SUBS_FILE, 'drive', await folder(DUES_FOLDER), list),
  };
}

// Loads Google's sign-in library once.
export function loadGoogle() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => resolve(); s.onerror = () => reject(new Error('Could not load Google sign-in. Check your internet connection.'));
    document.head.append(s);
  });
}

// Asks Google for an access token. `silent` tries without showing the consent window again.
export async function getToken(clientId, { silent = false } = {}) {
  await loadGoogle();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPES,
      callback: r => (r.error ? reject(new Error(r.error_description || r.error)) : resolve({ token: r.access_token, expires: Date.now() + (Number(r.expires_in) || 3600) * 1000 })),
      error_callback: e => reject(new Error(e.message || e.type || 'Sign-in was cancelled')),
    });
    client.requestAccessToken({ prompt: silent ? '' : 'consent' });
  });
}

// The app's own lists, named the way the sync expects. Transactions are kept in S.txs in the app.
export function localState(S) {
  return {
    projects: S.projects || [], accounts: S.accounts || [], loans: S.loans || [], advances: S.advances || [],
    funding: S.funding || [], parties: S.parties || [], budgets: S.budgets || [], plans: S.plans || [],
    statements: S.statements || [], transactions: S.txs || [],
  };
}
