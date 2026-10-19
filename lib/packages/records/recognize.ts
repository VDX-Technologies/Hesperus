// Column recognition with no model service: each column of a file is judged by its header and by
// its values (dates, numbers and their range, how many distinct values, how long, whether they
// are subjects the register already knows), then by what the register learned from earlier
// uploads: a naive Bayes count of header words and value traits per field, kept in the source's
// config. A file whose columns were all seen before (same signature) is mapped as it was last time.
import { createHash } from "node:crypto";
import { parseDate, parseNumber } from "./index";
import { FIELD_WORDS, RECORD_FIELDS, REQUIRED_FIELDS, words, type RecordField } from "./model";

/** What the register remembers: feature counts per field ("" = ignored) and mappings by signature. */
export interface Memory {
  counts: Record<string, Record<string, number>>;
  totals: Record<string, number>;
  signatures: Record<string, Record<string, string>>;
}

export const emptyMemory = (): Memory => ({ counts: {}, totals: {}, signatures: {} });

export function readMemory(v: unknown): Memory {
  const m = (v && typeof v === "object" ? v : {}) as Partial<Memory>;
  return { counts: m.counts ?? {}, totals: m.totals ?? {}, signatures: m.signatures ?? {} };
}

export interface Profile {
  filled: number;
  date: number;
  number: number;
  min: number;
  max: number;
  integer: number;
  distinct: number;
  avgLength: number;
  known: number;
  short: number;
}

/** Shares (0..1) of the non-empty values of a column that read as each kind of value. */
export function profile(values: string[], subjects: Set<string> = new Set()): Profile {
  const v = values.map((s) => s.trim()).filter(Boolean);
  const n = v.length || 1;
  const nums: number[] = [];
  let dates = 0, known = 0, short = 0, len = 0;
  for (const s of v) {
    len += s.length;
    if (subjects.has(s.toLowerCase())) known++;
    if (/^\p{L}{1,4}(?:\/\p{L}{1,3})?\.?$/u.test(s)) short++;
    // a bare number is not taken for a date
    if (/\d[/.-]\d|^\d{4}-\d{2}-\d{2}/.test(s))
      try {
        parseDate(s);
        dates++;
        continue;
      } catch {}
    try {
      const x = parseNumber(s, "");
      if (x !== undefined) nums.push(x);
    } catch {}
  }
  return {
    filled: v.length / Math.max(1, values.length),
    date: dates / n,
    number: nums.length / n,
    min: nums.length ? Math.min(...nums) : 0,
    max: nums.length ? Math.max(...nums) : 0,
    integer: nums.length ? nums.filter(Number.isInteger).length / nums.length : 0,
    distinct: new Set(v.map((s) => s.toLowerCase())).size / n,
    avgLength: len / n,
    known: known / n,
    short: short / n,
  };
}

/** Features the learned counts are kept on: header words and coarse value traits. */
export function features(header: string, p: Profile): string[] {
  const out = words(header).filter((w) => !/^#?\d+$/.test(w)).map((w) => `h:${w}`);
  const kind = p.date > 0.7 ? "date" : p.number > 0.7 ? "num" : p.short > 0.7 ? "short" : p.avgLength > 25 ? "long" : "text";
  out.push(`v:${kind}`);
  if (kind === "num") out.push(`v:mag${Math.max(-1, Math.min(4, Math.floor(Math.log10(Math.max(1e-3, Math.abs(p.max))))))}`, p.integer > 0.9 ? "v:int" : "v:dec");
  if (kind === "text" || kind === "short") out.push(p.distinct < 0.3 ? "v:few" : p.distinct > 0.8 ? "v:many" : "v:some");
  if (p.known > 0.5) out.push("v:known");
  return out;
}

const vocab = Object.fromEntries(RECORD_FIELDS.map((f) => [f, new Set(FIELD_WORDS[f].flatMap(words))])) as Record<RecordField, Set<string>>;

/** Score of a field for a column from rules alone: header words plus what the values allow. */
function ruleScore(field: RecordField, header: string, p: Profile): number {
  const ws = words(header);
  let s = vocab[field].has(ws[0] ?? "") ? 3 : ws.some((w) => vocab[field].has(w)) ? 2 : 0;
  const text = 1 - p.date - p.number;
  switch (field) {
    case "date":
      s += p.date > 0.8 ? 3 : p.date < 0.5 ? -6 : 0;
      break;
    case "subject":
      s += p.known * 4 + (text > 0.8 ? 0.5 : -4) + (p.distinct < 0.6 ? 0.5 : 0) - (p.avgLength > 30 ? 2 : 0);
      break;
    case "quantity":
    case "dose":
    case "area":
      s += p.number > 0.8 ? 0.5 : -6;
      // doses are small, areas in hectares rarely huge, harvests often large
      if (field === "dose") s += p.max <= 50 ? 0.5 : -1;
      if (field === "quantity") s += p.max > 50 ? 0.5 : 0;
      break;
    case "unit":
      s += p.short > 0.8 ? 1.5 : -3;
      break;
    case "kind":
    case "product":
    case "operator":
      s += text > 0.8 ? 0 : -4;
      if (field === "kind") s += p.distinct < 0.4 ? 0.5 : 0;
      break;
    case "note":
      s += text > 0.8 ? (p.avgLength > 25 ? 1.5 : 0) : -4;
      break;
  }
  return s;
}

/** Log-odds the memory gives a field for these features; 0 when nothing was learned. */
function learnedScore(mem: Memory, field: string, feats: string[]): number {
  const classes = Object.keys(mem.totals);
  if (!classes.length) return 0;
  const k = classes.length + 1;
  let s = 0;
  for (const f of feats) {
    const all = classes.reduce((a, c) => a + (mem.counts[c]?.[f] ?? 0), 0);
    if (!all) continue;
    // P(field | feature) against an even share, with a little smoothing
    s += Math.log(((mem.counts[field]?.[f] ?? 0) + 0.2) / (all + 0.2 * k)) + Math.log(k);
  }
  return s;
}

export interface Guess {
  header: string;
  field: RecordField | "";
  /** 0..1: how sure the field is right (ignored columns too). */
  confidence: number;
  /** "memory" when the file signature was seen before. */
  by: "memory" | "learned" | "rules";
}

export interface Recognition {
  signature: string;
  known: boolean;
  columns: Guess[];
  /** Required fields no column fills. */
  missing: RecordField[];
}

/** Same columns in any order give the same signature. */
export const signature = (headers: string[]) =>
  createHash("sha256").update(headers.map((h) => words(h).join(" ")).sort().join("\u0000")).digest("hex").slice(0, 16);

const IGNORE = 1;

/**
 * The field each column fills. Scores every (column, field) pair, then hands fields out best pair
 * first, one column per field; a column whose best is below the ignore score is left out.
 */
export function recognize(
  table: { headers: string[]; rows: string[][] },
  opts: { memory?: Memory; mapping?: Record<string, string>; subjects?: Set<string> } = {},
): Recognition {
  const mem = opts.memory ?? emptyMemory();
  const { headers, rows } = table;
  const sig = signature(headers);
  const seen = mem.signatures[sig];
  const missing = (cols: Guess[]) => REQUIRED_FIELDS.filter((f) => !cols.some((c) => c.field === f));
  if (seen) {
    const columns = headers.map((h) => ({ header: h, field: (seen[h] ?? "") as RecordField | "", confidence: 1, by: "memory" as const }));
    return { signature: sig, known: true, columns, missing: missing(columns) };
  }

  const sample = rows.slice(0, 200);
  const learned = Object.keys(mem.totals).length > 0;
  const scores = headers.map((h, i) => {
    const p = profile(sample.map((r) => r[i] ?? ""), opts.subjects);
    const feats = features(h, p);
    const row: Record<string, number> = { "": IGNORE + learnedScore(mem, "", feats) };
    for (const f of RECORD_FIELDS) row[f] = ruleScore(f, h, p) + learnedScore(mem, f, feats);
    // a mapping saved for this exact header weighs like a strong rule
    const saved = opts.mapping?.[h];
    if (saved !== undefined && saved in row) row[saved] += 4;
    if (p.filled === 0) row[""] += 10;
    return row;
  });

  const field: (RecordField | "")[] = headers.map(() => "");
  const pairs = scores.flatMap((row, i) => RECORD_FIELDS.map((f) => ({ i, f, s: row[f] }))).sort((a, b) => b.s - a.s);
  const used = new Set<string>(), done = new Set<number>();
  for (const { i, f, s } of pairs) {
    if (used.has(f) || done.has(i) || s <= scores[i][""]) continue;
    field[i] = f;
    used.add(f);
    done.add(i);
  }

  const columns = headers.map((h, i): Guess => {
    // softmax over the column's options still open to it, at a temperature that makes 3 points ≈ 95%
    const options = ["", ...RECORD_FIELDS.filter((f) => !used.has(f) || field[i] === f)];
    const z = options.map((f) => Math.exp(scores[i][f]));
    const confidence = Math.exp(scores[i][field[i]]) / z.reduce((a, b) => a + b, 0);
    return { header: h, field: field[i], confidence: Math.round(confidence * 100) / 100, by: learned ? "learned" : "rules" };
  });
  return { signature: sig, known: false, columns, missing: missing(columns) };
}

/** Memory after a file was loaded with this mapping: counts every column's features under its field. */
export function learn(
  mem: Memory,
  table: { headers: string[]; rows: string[][] },
  mapping: Record<string, string>,
  subjects?: Set<string>,
  maxSignatures = 200,
): Memory {
  const out: Memory = structuredClone(mem);
  const sample = table.rows.slice(0, 200);
  table.headers.forEach((h, i) => {
    const f = mapping[h] ?? "";
    const c = (out.counts[f] ??= {});
    for (const x of features(h, profile(sample.map((r) => r[i] ?? ""), subjects))) c[x] = (c[x] ?? 0) + 1;
    out.totals[f] = (out.totals[f] ?? 0) + 1;
  });
  const sig = signature(table.headers);
  delete out.signatures[sig];
  out.signatures[sig] = Object.fromEntries(table.headers.map((h) => [h, mapping[h] ?? ""]));
  // the oldest signatures go first
  const keys = Object.keys(out.signatures);
  for (const k of keys.slice(0, Math.max(0, keys.length - maxSignatures))) delete out.signatures[k];
  return out;
}
