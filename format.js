// Dates are shown and typed as DD-MM-YYYY everywhere. Stored and exchanged internally as YYYY-MM-DD.
export const toDMY = iso => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
};

// Reads DD-MM-YYYY (also accepts D-M-YYYY and the slash form). Returns YYYY-MM-DD, or throws a readable error.
export function fromDMY(text) {
  const t = String(text ?? '').trim().replace(/[\/.]/g, '-');
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(t);
  if (!m) throw new Error('Enter the date as DD-MM-YYYY, for example 10-11-2026');
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10) !== iso) throw new Error(`"${t}" is not a real date`);
  return iso;
}

// Calendar helpers used by the ledger ranges.
export const monthRange = ym => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
};
export const yearRange = y => ({ from: `${y}-01-01`, to: `${y}-12-31` });
export const ALL_RANGE = { from: '0000-01-01', to: '9999-12-31' };
