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

export interface ExtractOptions {
  maxBytes?: number;
  maxRows?: number;
  maxColumns?: number;
  maxSheets?: number;
  maxPages?: number;
  maxCells?: number;
  maxTextChars?: number;
  maxInflatedBytes?: number;
}

export type ExtractLimit = "bytes" | "rows" | "columns" | "sheets" | "pages" | "cells" | "text" | "inflated";

export class ExtractLimitError extends Error {
  constructor(public readonly limit: ExtractLimit, max: number) {
    super(`file exceeds the ${limit} limit (${max})`);
    this.name = "ExtractLimitError";
  }
}

const limits = (options: ExtractOptions = {}) => ({
  maxBytes: options.maxBytes ?? 5 * 1024 ** 2,
  maxRows: options.maxRows ?? 5_000,
  maxColumns: options.maxColumns ?? 200,
  maxSheets: options.maxSheets ?? 20,
  maxPages: options.maxPages ?? 500,
  maxCells: options.maxCells ?? 1_000_000,
  maxTextChars: options.maxTextChars ?? 500_000,
  maxInflatedBytes: options.maxInflatedBytes ?? 100 * 1024 ** 2,
});

function checkText(text: string, maxTextChars: number) {
  if (text.length > maxTextChars) throw new ExtractLimitError("text", maxTextChars);
}

function checkTable(table: Table | null, max: ReturnType<typeof limits>): Table | null {
  if (!table) return null;
  if (table.rows.length > max.maxRows) throw new ExtractLimitError("rows", max.maxRows);
  if (table.headers.length > max.maxColumns) throw new ExtractLimitError("columns", max.maxColumns);
  if ((table.rows.length + 1) * table.headers.length > max.maxCells) throw new ExtractLimitError("cells", max.maxCells);
  return table;
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

export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const filled = (row: string[]) => row.filter((c) => c.trim() !== "").length;

function tidy(headers: string[], rows: string[][]): Table | null {
  rows = rows.filter((r) => filled(r) > 0);
  const width = Math.max(headers.length, ...rows.map((r) => r.length));
  const keep = Array.from({ length: width }, (_, i) => i).filter((i) => (headers[i] ?? "").trim() || rows.some((r) => (r[i] ?? "").trim()));
  if (keep.length < 2 || !rows.length) return null;
  const pick = (r: string[]) => keep.map((i) => (r[i] ?? "").trim());
  return { headers: pick(headers).map((h, i) => h || `#${i + 1}`), rows: rows.map(pick) };
}

export function findTable(grid: string[][]): Table | null {
  const width = Math.max(0, ...grid.slice(0, 50).map(filled));
  if (width < 2) return null;
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const row = grid[i];
    const cells = row.filter((c) => c.trim() !== "");
    const words = cells.filter((c) => !/^[-+]?[\d.,:/\s%€$]+$/.test(c)).length;
    if (cells.length >= Math.max(2, width / 2) && words >= cells.length * 0.6) {
      const key = row.join("\u0000");
      return tidy(row, grid.slice(i + 1).filter((r) => r.join("\u0000") !== key));
    }
  }
  return null;
}

function cellText(v: unknown): string {
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  return v == null ? "" : String(v);
}

function checkZip(bytes: Uint8Array, max: number) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--)
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) return;
  const entries = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true), total = 0;
  for (let n = 0; n < entries && at + 46 <= bytes.length && view.getUint32(at, true) === 0x02014b50; n++) {
    const size = view.getUint32(at + 24, true);
    total += size === 0xffffffff ? Infinity : size;
    if (total > max) throw new ExtractLimitError("inflated", max);
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
}

function readSheet(bytes: Uint8Array, max: ReturnType<typeof limits>): Extracted {
  checkZip(bytes, max.maxInflatedBytes);
  const book = XLSX.read(bytes, { type: "array", cellDates: true, UTC: true, dense: true, sheetRows: max.maxRows + 31 });
  if (book.SheetNames.length > max.maxSheets) throw new ExtractLimitError("sheets", max.maxSheets);
  let table: Table | null = null;
  const text: string[] = [];
  let textLength = 0, cellCount = 0;
  const append = (value: string) => {
    textLength += value.length + (text.length ? 1 : 0);
    if (textLength > max.maxTextChars) throw new ExtractLimitError("text", max.maxTextChars);
    text.push(value);
  };
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    const fullref = (sheet as typeof sheet & { "!fullref"?: string })["!fullref"] ?? sheet["!ref"];
    if (fullref) {
      const range = XLSX.utils.decode_range(fullref);
      if (range.e.r + 1 > max.maxRows + 30) throw new ExtractLimitError("rows", max.maxRows);
      if (range.e.c + 1 > max.maxColumns) throw new ExtractLimitError("columns", max.maxColumns);
    }
    const grid = XLSX.utils
      .sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "", blankrows: false, UTC: true })
      .map((r) => r.map(cellText));
    if (!grid.length) continue;
    for (const row of grid) {
      if (row.length > max.maxColumns) throw new ExtractLimitError("columns", max.maxColumns);
      cellCount += row.length;
      if (cellCount > max.maxCells) throw new ExtractLimitError("cells", max.maxCells);
    }
    append(`# ${name}`);
    for (const row of grid) append(row.join("\t"));
    const t = findTable(grid);
    if (t && t.rows.length > max.maxRows) throw new ExtractLimitError("rows", max.maxRows);
    if (t && (!table || t.rows.length > table.rows.length)) table = t;
  }
  return { format: "sheet", table: checkTable(table, max), text: text.join("\n") || null };
}

function readDelimited(text: string, strict: boolean, max: ReturnType<typeof limits>): Table | null {
  let csv: Csv;
  try {
    csv = parseCsv(text, max.maxRows, max.maxColumns);
  } catch (e) {
    if (e instanceof RangeError) {
      const columnLimit = e.message.includes("columns");
      throw new ExtractLimitError(columnLimit ? "columns" : "rows", columnLimit ? max.maxColumns : max.maxRows);
    }
    return null;
  }
  if (strict && (csv.headers.length < 2 || csv.rows.filter((r) => r.length === csv.headers.length).length < Math.max(2, csv.rows.length * 0.8)))
    return null;
  const cells = csv.headers.length + csv.rows.reduce((n, row) => n + row.length, 0);
  if (cells > max.maxCells) throw new ExtractLimitError("cells", max.maxCells);
  return checkTable(findTable([csv.headers, ...csv.rows]), max);
}

interface Cell {
  text: string;
  x0: number;
  x1: number;
}

export function layoutTable(lines: Cell[][]): Table | null {
  let best: [number, number] = [0, 0];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && lines[j].length >= 2) j++;
    if (j - i > best[1] - best[0]) best = [i, j];
    i = j + 1;
  }
  if (best[1] - best[0] < 3) return null;
  let h = best[0];
  while (h < best[1] - 2 && lines[h].filter((c) => /\p{L}/u.test(c.text)).length < lines[h].length * 0.6) h++;
  const head = lines[h];
  const centre = (c: Cell) => (c.x0 + c.x1) / 2;
  const column = (c: Cell) => {
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

function textLines(text: string, max: ReturnType<typeof limits>): Cell[][] {
  checkText(text, max.maxTextChars);
  let cellCount = 0;
  return text.split(/\r?\n/).map((line) => {
    const cells: Cell[] = [];
    for (const m of line.matchAll(/[^\t ]+(?: [^\t ]+)*/g)) {
      cells.push({ text: m[0], x0: m.index, x1: m.index + m[0].length });
      cellCount++;
      if (cells.length > max.maxColumns) throw new ExtractLimitError("columns", max.maxColumns);
      if (cellCount > max.maxCells) throw new ExtractLimitError("cells", max.maxCells);
    }
    return cells;
  });
}

async function readPdf(bytes: Uint8Array, max: ReturnType<typeof limits>): Promise<Extracted> {
  const { extractTextItems } = await import("unpdf");
  const { items } = await extractTextItems(new Uint8Array(bytes));
  if (items.length > max.maxPages) throw new ExtractLimitError("pages", max.maxPages);
  const lines: Cell[][] = [];
  let charCount = 0, cellCount = 0;
  for (const page of items) {
    const words = page.filter((w) => w.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
    for (const w of words) {
      charCount += w.str.length;
      if (charCount > max.maxTextChars) throw new ExtractLimitError("text", max.maxTextChars);
    }
    const pageLines: (typeof words)[] = [];
    for (const w of words) {
      const last = pageLines.at(-1);
      if (last && Math.abs(last[0].y - w.y) <= Math.max(2, w.fontSize / 3)) last.push(w);
      else pageLines.push([w]);
    }
    for (const l of pageLines) {
      l.sort((a, b) => a.x - b.x);
      const cells: Cell[] = [];
      for (const w of l) {
        cellCount++;
        if (cellCount > max.maxCells) throw new ExtractLimitError("cells", max.maxCells);
        const c = cells.at(-1);
        if (c && w.x - c.x1 < Math.max(w.fontSize * 0.6, 3)) {
          c.text += (w.x - c.x1 > w.fontSize * 0.15 ? " " : "") + w.str.trim();
          c.x1 = w.x + w.width;
        } else {
          cells.push({ text: w.str.trim(), x0: w.x, x1: w.x + w.width });
          if (cells.length > max.maxColumns) throw new ExtractLimitError("columns", max.maxColumns);
        }
      }
      lines.push(cells);
    }
  }
  const text = lines.map((l) => l.map((c) => c.text).join("\t")).join("\n");
  checkText(text, max.maxTextChars);
  return { format: "pdf", table: checkTable(layoutTable(lines), max), text: text || null };
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

async function readWord(bytes: Uint8Array, max: ReturnType<typeof limits>): Promise<Extracted> {
  checkZip(bytes, max.maxInflatedBytes);
  const mammoth = await import("mammoth");
  const buffer = Buffer.from(bytes);
  const [{ value: html }, { value: text }] = await Promise.all([mammoth.convertToHtml({ buffer }), mammoth.extractRawText({ buffer })]);
  checkText(html, max.maxTextChars * 5);
  checkText(text, max.maxTextChars);
  let table: Table | null = null;
  let tableCount = 0, cellCount = 0;
  for (const [t] of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    tableCount++;
    if (tableCount > max.maxSheets) throw new ExtractLimitError("sheets", max.maxSheets);
    const grid = [...t.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(([tr]) => [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => unescape(m[1])));
    for (const row of grid) {
      if (row.length > max.maxColumns) throw new ExtractLimitError("columns", max.maxColumns);
      cellCount += row.length;
      if (cellCount > max.maxCells) throw new ExtractLimitError("cells", max.maxCells);
    }
    if (grid.length > max.maxRows + 30) throw new ExtractLimitError("rows", max.maxRows);
    const found = findTable(grid);
    checkTable(found, max);
    if (found && (!table || found.rows.length > table.rows.length)) table = found;
  }
  return { format: "word", table: checkTable(table ?? layoutTable(textLines(text, max)), max), text: text.trim() || null };
}

export async function extract(name: string, type: string | undefined, bytes: Uint8Array, options: ExtractOptions = {}): Promise<Extracted> {
  const max = limits(options);
  if (bytes.length > max.maxBytes) throw new ExtractLimitError("bytes", max.maxBytes);
  const format = fileFormat(name, type);
  try {
    switch (format) {
      case "csv": {
        const text = decodeText(bytes);
        checkText(text, max.maxTextChars);
        return { format, table: readDelimited(text, false, max), text };
      }
      case "sheet":
        return readSheet(bytes, max);
      case "pdf":
        return await readPdf(bytes, max);
      case "word":
        return await readWord(bytes, max);
      case "text": {
        const text = decodeText(bytes);
        checkText(text, max.maxTextChars);
        return { format, table: checkTable(readDelimited(text, true, max) ?? layoutTable(textLines(text, max)), max), text };
      }
      case "other": {
        const zip = bytes[0] === 0x50 && bytes[1] === 0x4b, ole = bytes[0] === 0xd0 && bytes[1] === 0xcf;
        if (zip || ole) {
          try {
            const s = readSheet(bytes, max);
            if (s.table) return s;
          } catch (e) {
            if (e instanceof ExtractLimitError) throw e;
          }
          return { format, table: null, text: null };
        }
        const text = decodeText(bytes);
        checkText(text, max.maxTextChars);
        if ((text.match(/[\u0000-\u0008\u000e-\u001f�]/g)?.length ?? 0) > text.length / 100) return { format, table: null, text: null };
        return { format: "text", table: checkTable(readDelimited(text, true, max) ?? layoutTable(textLines(text, max)), max), text };
      }
      default:
        return { format, table: null, text: null };
    }
  } catch (e) {
    if (e instanceof ExtractLimitError) throw e;
    return { format, table: null, text: null };
  }
}
