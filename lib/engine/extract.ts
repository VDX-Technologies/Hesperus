// Reads whatever a user uploads, with no network and no model: spreadsheets (xlsx, xls, ods…),
// delimited text, Word documents, PDFs and plain text. Each file gives back its full text (kept
// for search) and, when one can be found, a table: header row plus data rows. Spreadsheet header
// rows are found under titles, Word tables are read as they are, and PDF tables are rebuilt from
// where the words sit on the page.
import * as XLSX from "xlsx";
import { parseCsv, type Csv } from "./csv";

export type FileFormat = "csv" | "sheet" | "pdf" | "word" | "text" | "image" | "other";

export interface Table {
  headers: string[];
  rows: string[][];
}

export interface Extracted {
  format: FileFormat;
  table: Table | null;
  text: string | null;
}

const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

const SHEET = new Set(["xlsx", "xlsm", "xlsb", "xls", "ods", "fods", "numbers", "et"]);
const WORD = new Set(["docx", "docm"]);
const TEXT = new Set(["txt", "text", "md", "log", "json", "xml", "html", "htm", "rtf", "dat"]);
const IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg"]);

export function fileFormat(name: string, type = ""): FileFormat {
  const e = ext(name);
  if (e === "csv" || e === "tsv" || type === "text/csv") return "csv";
  if (SHEET.has(e) || type.includes("spreadsheet") || type.includes("excel")) return "sheet";
  if (e === "pdf" || type === "application/pdf") return "pdf";
  if (WORD.has(e) || type.includes("wordprocessingml")) return "word";
  if (IMAGE.has(e) || type.startsWith("image/")) return "image";
  if (TEXT.has(e) || type.startsWith("text/")) return "text";
  return "other";
}

/** UTF-8 if valid, else Windows-1252 (what spreadsheets on Windows export). */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const filled = (row: string[]) => row.filter((c) => c.trim() !== "").length;

/** Drops empty rows and columns that are empty in every row, then pads rows to the header. */
function tidy(headers: string[], rows: string[][]): Table | null {
  rows = rows.filter((r) => filled(r) > 0);
  const width = Math.max(headers.length, ...rows.map((r) => r.length));
  const keep = Array.from({ length: width }, (_, i) => i).filter((i) => (headers[i] ?? "").trim() || rows.some((r) => (r[i] ?? "").trim()));
  if (keep.length < 2 || !rows.length) return null;
  const pick = (r: string[]) => keep.map((i) => (r[i] ?? "").trim());
  // a header cell left blank is named after its column, so it can still be mapped
  return { headers: pick(headers).map((h, i) => h || `#${i + 1}`), rows: rows.map(pick) };
}

/**
 * The header of a grid: the first row, among the top ones, that fills at least half of the widest
 * row and is mostly words. Titles, dates and notes above a spreadsheet table are skipped.
 */
export function findTable(grid: string[][]): Table | null {
  const width = Math.max(0, ...grid.slice(0, 50).map(filled));
  if (width < 2) return null;
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const row = grid[i];
    const cells = row.filter((c) => c.trim() !== "");
    const words = cells.filter((c) => !/^[-+]?[\d.,:/\s%€$]+$/.test(c)).length;
    if (cells.length >= Math.max(2, width / 2) && words >= cells.length * 0.6) {
      // repeated headers (one per printed page) are not data
      const key = row.join("\u0000");
      return tidy(row, grid.slice(i + 1).filter((r) => r.join("\u0000") !== key));
    }
  }
  return null;
}

/** Spreadsheet cells as text: dates as "YYYY-MM-DD" or "YYYY-MM-DD HH:mm", numbers unformatted. */
function cellText(v: unknown): string {
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  return v == null ? "" : String(v);
}

function readSheet(bytes: Uint8Array): Extracted {
  const wb = XLSX.read(bytes, { type: "array", cellDates: true, UTC: true, dense: true });
  let table: Table | null = null;
  const text: string[] = [];
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils
      .sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: "", blankrows: false, UTC: true })
      .map((r) => r.map(cellText));
    if (!grid.length) continue;
    text.push(`# ${name}`, ...grid.map((r) => r.join("\t")));
    // the sheet with the most rows is the data; the others are often notes or lookups
    const t = findTable(grid);
    if (t && (!table || t.rows.length > table.rows.length)) table = t;
  }
  return { format: "sheet", table, text: text.join("\n") || null };
}

/** Delimited text; for a file not named .csv, most rows must have as many cells as the header. */
function readDelimited(text: string, strict = false): Table | null {
  let csv: Csv;
  try {
    csv = parseCsv(text);
  } catch {
    return null;
  }
  if (strict && (csv.headers.length < 2 || csv.rows.filter((r) => r.length === csv.headers.length).length < Math.max(2, csv.rows.length * 0.8)))
    return null;
  return findTable([csv.headers, ...csv.rows]);
}

/** A cell of a laid out line: its text and horizontal span. */
interface Cell {
  text: string;
  x0: number;
  x1: number;
}

/**
 * A table out of laid out lines (PDF words by position, or plain text by character column): the
 * longest run of lines with two or more cells gives the header, then every later line with two or
 * more cells is a row, each cell going to the header column it sits under.
 */
export function layoutTable(lines: Cell[][]): Table | null {
  let best: [number, number] = [0, 0];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && lines[j].length >= 2) j++;
    if (j - i > best[1] - best[0]) best = [i, j];
    i = j + 1;
  }
  if (best[1] - best[0] < 3) return null;
  // the header is the run's first line that is mostly words
  let h = best[0];
  while (h < best[1] - 2 && lines[h].filter((c) => /\p{L}/u.test(c.text)).length < lines[h].length * 0.6) h++;
  const head = lines[h];
  const centre = (c: Cell) => (c.x0 + c.x1) / 2;
  const column = (c: Cell) => {
    // the header column it overlaps the most, else the nearest one
    let at = 0, score = -Infinity;
    head.forEach((hc, k) => {
      const s = Math.min(c.x1, hc.x1) - Math.max(c.x0, hc.x0) || -Math.abs(centre(c) - centre(hc));
      if (s > score) [at, score] = [k, s];
    });
    return at;
  };
  const key = head.map((c) => c.text).join("\u0000");
  const rows = lines
    .slice(h + 1)
    .filter((l) => l.length >= 2 && l.map((c) => c.text).join("\u0000") !== key)
    .map((l) => {
      const row = head.map(() => "");
      for (const c of l) {
        const k = column(c);
        row[k] = row[k] ? `${row[k]} ${c.text}` : c.text;
      }
      return row;
    });
  return tidy(head.map((c) => c.text), rows);
}

/** Plain text laid out in columns: cells are split on tabs or runs of two or more spaces. */
function textLines(text: string): Cell[][] {
  return text.split(/\r?\n/).map((line) => {
    const cells: Cell[] = [];
    for (const m of line.matchAll(/[^\t ]+(?: [^\t ]+)*/g)) cells.push({ text: m[0], x0: m.index, x1: m.index + m[0].length });
    return cells;
  });
}

async function readPdf(bytes: Uint8Array): Promise<Extracted> {
  const { extractTextItems } = await import("unpdf");
  const { items } = await extractTextItems(new Uint8Array(bytes));
  const lines: Cell[][] = [];
  for (const page of items) {
    // words on the same baseline (within a third of the font size) make a line, top to bottom
    const words = page.filter((w) => w.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
    const pageLines: (typeof words)[] = [];
    for (const w of words) {
      const last = pageLines.at(-1);
      if (last && Math.abs(last[0].y - w.y) <= Math.max(2, w.fontSize / 3)) last.push(w);
      else pageLines.push([w]);
    }
    for (const l of pageLines) {
      l.sort((a, b) => a.x - b.x);
      // a gap wider than about one space ends the cell
      const cells: Cell[] = [];
      for (const w of l) {
        const c = cells.at(-1);
        if (c && w.x - c.x1 < Math.max(w.fontSize * 0.6, 3)) {
          c.text += (w.x - c.x1 > w.fontSize * 0.15 ? " " : "") + w.str.trim();
          c.x1 = w.x + w.width;
        } else cells.push({ text: w.str.trim(), x0: w.x, x1: w.x + w.width });
      }
      lines.push(cells);
    }
  }
  const text = lines.map((l) => l.map((c) => c.text).join("\t")).join("\n");
  return { format: "pdf", table: layoutTable(lines), text: text || null };
}

const unescape = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

async function readWord(bytes: Uint8Array): Promise<Extracted> {
  const mammoth = await import("mammoth");
  const buffer = Buffer.from(bytes);
  const [{ value: html }, { value: text }] = await Promise.all([mammoth.convertToHtml({ buffer }), mammoth.extractRawText({ buffer })]);
  // the biggest table of the document
  let table: Table | null = null;
  for (const [t] of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const grid = [...t.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(([tr]) => [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => unescape(m[1])));
    const found = findTable(grid);
    if (found && (!table || found.rows.length > table.rows.length)) table = found;
  }
  return { format: "word", table: table ?? layoutTable(textLines(text)), text: text.trim() || null };
}

/** Reads any file. A file that cannot be understood still comes back, with no table and no text. */
export async function extract(name: string, type: string | undefined, bytes: Uint8Array): Promise<Extracted> {
  const format = fileFormat(name, type);
  try {
    switch (format) {
      case "csv": {
        const text = decodeText(bytes);
        return { format, table: readDelimited(text), text };
      }
      case "sheet":
        return readSheet(bytes);
      case "pdf":
        return await readPdf(bytes);
      case "word":
        return await readWord(bytes);
      case "text": {
        const text = decodeText(bytes);
        return { format, table: readDelimited(text, true) ?? layoutTable(textLines(text)), text };
      }
      case "other": {
        // an unknown extension may still be a spreadsheet (a zip, or an old Office file) or text
        const zip = bytes[0] === 0x50 && bytes[1] === 0x4b, ole = bytes[0] === 0xd0 && bytes[1] === 0xcf;
        if (zip || ole) {
          try {
            const s = readSheet(bytes);
            if (s.table) return s;
          } catch {}
          return { format, table: null, text: null };
        }
        const text = decodeText(bytes);
        // binary files decode to many control characters
        if ((text.match(/[\u0000-\u0008\u000e-\u001f�]/g)?.length ?? 0) > text.length / 100) return { format, table: null, text: null };
        return { format: "text", table: readDelimited(text, true) ?? layoutTable(textLines(text)), text };
      }
      default:
        return { format, table: null, text: null };
    }
  } catch {
    return { format, table: null, text: null };
  }
}
