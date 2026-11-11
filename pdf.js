// Minimal PDF writer (A4, Helvetica, text / lines / shaded rows, multi-page). No dependencies, works offline.
const W = 595, H = 842, L = 40, R = 555;
const CHAR = { ' ': .278, '.': .278, ',': .278, '-': .333, '/': .278, ':': .278, '(': .333, ')': .333, '+': .584, '%': .889 };

// Helvetica (WinAnsi) can't draw Arabic or emoji, so text is reduced to plain ASCII.
export function toAscii(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')          // é → e, ü → u
    .replace(/[\u2212\u2013\u2014]/g, '-').replace(/\u2192/g, '->').replace(/\u00b7/g, '|')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e]/g, '?');
}
const esc = s => toAscii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
export function textWidth(s, size, bold) {
  let w = 0;
  for (const ch of toAscii(s)) w += CHAR[ch] ?? (/[0-9]/.test(ch) ? .556 : .58);
  return w * size * (bold ? 1.06 : 1);
}

export class Pdf {
  constructor({ title, footer = '' }) {
    this.title = title; this.footer = footer; this.pages = []; this.header = null;
    this.newPage();
  }
  newPage() {
    this.ops = []; this.pages.push(this.ops); this.y = 40;
    if (this.header) this.row(this.header, { bold: true, shade: true });
  }
  ensure(h) { if (this.y + h > H - 50) this.newPage(); }
  text(x, y, s, { size = 10, bold = false, align = 'left', gray = 0 } = {}) {
    const w = textWidth(s, size, bold);
    const xx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`${gray} g BT /${bold ? 'F2' : 'F1'} ${size} Tf ${xx.toFixed(2)} ${(H - y).toFixed(2)} Td (${esc(s)}) Tj ET`);
  }
  rect(x, y, w, h, gray = .93) { this.ops.push(`${gray} g ${x} ${(H - y - h).toFixed(2)} ${w} ${h} re f`); }
  line(x1, y1, x2, y2, gray = .7, lw = .6) { this.ops.push(`${gray} G ${lw} w ${x1} ${(H - y1).toFixed(2)} m ${x2} ${(H - y2).toFixed(2)} l S`); }

  // cols: [{ x, t, align, bold, gray }]
  row(cols, { size = 9, bold = false, shade = false } = {}) {
    this.ensure(size + 10);
    if (shade) this.rect(L, this.y - 2, R - L, size + 7, .92);
    for (const c of cols) this.text(c.x, this.y + size, c.t ?? '', { size, bold: c.bold ?? bold, align: c.align, gray: c.gray ?? 0 });
    this.y += size + 7;
  }
  // Repeats this header row at the top of every new page.
  setHeader(cols) { this.header = cols; this.row(cols, { bold: true, shade: true }); }
  rule() { this.line(L, this.y, R, this.y); this.y += 8; }
  gap(n = 8) { this.y += n; }
  heading(s) { this.ensure(34); this.y += 6; this.text(L, this.y + 12, s, { size: 12, bold: true }); this.y += 22; }
  titleBlock(title, subtitle) {
    this.text(L, this.y + 18, title, { size: 18, bold: true }); this.y += 28;
    if (subtitle) { this.text(L, this.y + 9, subtitle, { size: 9, gray: .35 }); this.y += 16; }
    this.rule();
  }
  build() {
    const n = this.pages.length;
    this.pages.forEach((ops, i) => {
      const saved = this.ops; this.ops = ops;
      this.line(L, 812, R, 812, .8, .4);
      this.text(L, 824, this.footer, { size: 8, gray: .4 });
      this.text(R, 824, `Page ${i + 1} of ${n}`, { size: 8, align: 'right', gray: .4 });
      this.ops = saved;
    });
    return serialize(this.pages, this.title);
  }
}

function serialize(pages, title) {
  const objs = [null];
  const add = s => { objs.push(s); return objs.length - 1; };
  const catalog = add(null), pagesRef = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const ops of pages) {
    const content = ops.join('\n');                       // ASCII only, so length = bytes
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog] = `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`;
  objs[pagesRef] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(title)}) /Producer (DSi Wallet) /Creator (DSi Wallet) >>`);

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
