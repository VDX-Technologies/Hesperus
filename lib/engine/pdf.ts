import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const W = 841.89, H = 595.28, M = 32, SIZE = 8, LINE = 10;

const WIN_ANSI = /[^\x20-\x7E\xA0-\xFF€–—‘’“”•…]/g;
export const safe = (s: string) => s.replace(/\s+/g, " ").replace(WIN_ANSI, "?");

function wrap(text: string, font: PDFFont, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of safe(text).split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, SIZE) <= width) line = next;
    else {
      if (line) lines.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, SIZE) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), SIZE) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export interface PdfTable {
  title: string;
  subtitle: string;
  columns: { label: string; width: number }[];
  rows: Iterable<string[]> | AsyncIterable<string[]>;
  empty: string;
}

export async function tablePdf(t: PdfTable): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const inner = W - 2 * M;
  const total = t.columns.reduce((s, c) => s + c.width, 0) || 1;
  const widths = t.columns.map((c) => (c.width / total) * inner);
  const xs: number[] = [];
  let acc = M;
  for (const w of widths) {
    xs.push(acc);
    acc += w;
  }

  let page: PDFPage, y = 0, n = 0, count = 0;
  const line = (yy: number) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  const newPage = () => {
    page = doc.addPage([W, H]);
    n++;
    page.drawText(safe(t.title), { x: M, y: H - M, size: 13, font: bold });
    page.drawText(safe(t.subtitle), { x: M, y: H - M - 16, size: 9, font });
    page.drawText(String(n), { x: W - M - 10, y: M / 2, size: 8, font });
    y = H - M - 36;
    t.columns.forEach((c, i) => wrap(c.label, bold, widths[i] - 4).slice(0, 1).forEach((l) => page.drawText(l, { x: xs[i] + 2, y, size: SIZE, font: bold })));
    y -= 4;
    line(y);
  };
  newPage();

  for await (const r of t.rows) {
    count++;
    const cells = t.columns.map((_, i) => wrap(r[i] ?? "", font, widths[i] - 4));
    const h = Math.max(...cells.map((l) => l.length)) * LINE + 4;
    if (y - h < M) newPage();
    cells.forEach((ls, i) => ls.forEach((s, j) => page.drawText(s, { x: xs[i] + 2, y: y - LINE - j * LINE + 2, size: SIZE, font })));
    y -= h;
    line(y);
  }
  if (!count) page!.drawText(safe(t.empty), { x: M, y: y - 16, size: 9, font });
  return doc.save();
}
