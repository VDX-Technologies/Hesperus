// The register as a PDF laid out like the paper one: A4 landscape, one row per treatment, the
// columns in COLUMNS order, a header repeated on every page. Standard Helvetica only covers
// WinAnsi, so other characters are replaced rather than failing the whole export.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { COLUMNS, COLUMN_LABELS, cell, type Column, type RegisterRow } from "./register";

const WIDTHS: Record<Column, number> = { crop: 0.16, areaHa: 0.08, phase: 0.09, adversity: 0.15, product: 0.15, quantity: 0.09, date: 0.08, notes: 0.2 };
const W = 841.89, H = 595.28, M = 32, SIZE = 8, LINE = 10;

const WIN_ANSI = /[^\x20-\x7E\xA0-\xFF€–—‘’“”•…]/g;
const safe = (s: string) => s.replace(/\s+/g, " ").replace(WIN_ANSI, "?");

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

export async function registerPdf(rows: RegisterRow[], meta: { organization: string; period: string; locale: "en" | "it" }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const inner = W - 2 * M;
  const xs: number[] = [];
  let acc = M;
  for (const c of COLUMNS) {
    xs.push(acc);
    acc += WIDTHS[c] * inner;
  }
  const title = meta.locale === "it" ? "Registro dei trattamenti" : "Treatments register";

  let page: PDFPage, y = 0, n = 0;
  const line = (yy: number) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  const newPage = () => {
    page = doc.addPage([W, H]);
    n++;
    page.drawText(safe(title), { x: M, y: H - M, size: 13, font: bold });
    page.drawText(safe(`${meta.organization} · ${meta.period}`), { x: M, y: H - M - 16, size: 9, font });
    page.drawText(String(n), { x: W - M - 10, y: M / 2, size: 8, font });
    y = H - M - 36;
    COLUMNS.forEach((c, i) => page.drawText(safe(COLUMN_LABELS[c][meta.locale]), { x: xs[i] + 2, y, size: SIZE, font: bold }));
    y -= 4;
    line(y);
  };
  newPage();

  for (const r of rows) {
    const cells = COLUMNS.map((c) => wrap(cell(r, c, meta.locale), font, WIDTHS[c] * inner - 4));
    const h = Math.max(...cells.map((l) => l.length)) * LINE + 4;
    if (y - h < M) newPage();
    cells.forEach((ls, i) => ls.forEach((t, j) => page.drawText(t, { x: xs[i] + 2, y: y - LINE - j * LINE + 2, size: SIZE, font })));
    y -= h;
    line(y);
  }
  if (!rows.length) page!.drawText(meta.locale === "it" ? "Nessun trattamento nel periodo." : "No treatments in the period.", { x: M, y: y - 16, size: 9, font });
  return doc.save();
}
