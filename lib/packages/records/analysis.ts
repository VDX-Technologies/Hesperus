// What a register's entries say once taken together: totals, how the work spreads over time,
// subjects and products, and signals worth a decision (a subject left behind, a dose out of
// line with the same product elsewhere, an entry that looks recorded twice). Plain statistics:
// medians and median absolute deviation, so a few odd rows do not move the reference.
import type { RecordEntry } from "./console";

const DAY = 86_400_000;

export interface Totals {
  entries: number;
  subjects: number;
  products: number;
  dose: number;
  area: number;
  quantity: number;
  first: string | null;
  last: string | null;
}

export interface Share {
  key: string;
  objectId?: string;
  entries: number;
  area: number;
  quantity: number;
  last: string;
}

export type Signal =
  | { kind: "idle"; objectId: string; subject: string; days: number; usual: number }
  | { kind: "dose"; objectId: string; subject: string; product: string; ts: string; dose: number; usual: number }
  | { kind: "twice"; objectId: string; subject: string; product: string; ts: string; days: number };

export interface Analysis {
  /** True when summaries use only the most recent capped window. */
  partial: boolean;
  totals: Totals;
  /** Monday of each week (epoch ms) with entries per top product, "other" for the rest, area worked (_area) and its running total (_cum). */
  weeks: Record<string, number>[];
  products: string[];
  bySubject: Share[];
  byProduct: Share[];
  signals: Signal[];
  /** Entries per subject per week (same weeks as `weeks`), busiest subjects first. */
  matrix: { key: string; objectId: string; cells: number[] }[];
  /** Every dose of the top products, with whether it is out of line. */
  doses: { t: number; dose: number; product: string; subject: string; odd: boolean }[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const monday = (t: number) => {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function analyze(entries: RecordEntry[], now = new Date(), topProducts = 5, partial = false): Analysis {
  const rows = [...entries].sort((a, b) => a.ts.localeCompare(b.ts));
  const share = (map: Map<string, Share>, key: string, e: RecordEntry, objectId?: string, identity = key) => {
    const s = map.get(identity) ?? { key, objectId, entries: 0, area: 0, quantity: 0, last: e.ts };
    s.entries++;
    s.area += num(e.payload.area);
    s.quantity += num(e.payload.quantity);
    if (e.ts > s.last) s.last = e.ts;
    map.set(identity, s);
  };
  const subjects = new Map<string, Share>(), products = new Map<string, Share>();
  const subjectTimes = new Map<string, number[]>();
  const productDoses = new Map<string, RecordEntry[]>();
  const totals: Totals = { entries: rows.length, subjects: 0, products: 0, dose: 0, area: 0, quantity: 0, first: rows[0]?.ts ?? null, last: rows.at(-1)?.ts ?? null };
  for (const e of rows) {
    totals.dose += num(e.payload.dose);
    totals.area += num(e.payload.area);
    totals.quantity += num(e.payload.quantity);
    const subject = text(e.subject) || e.objectId.slice(0, 8);
    share(subjects, subject, e, e.objectId, e.objectId);
    const times = subjectTimes.get(e.objectId) ?? [];
    times.push(Date.parse(e.ts));
    subjectTimes.set(e.objectId, times);
    const p = text(e.payload.product);
    if (p) {
      share(products, p, e);
      if (num(e.payload.dose) > 0) {
        const doses = productDoses.get(p) ?? [];
        doses.push(e);
        productDoses.set(p, doses);
      }
    }
  }
  totals.subjects = subjects.size;
  totals.products = products.size;
  const bySubject = [...subjects.values()].sort((a, b) => b.entries - a.entries);
  const byProduct = [...products.values()].sort((a, b) => b.entries - a.entries);

  // weeks with the main products stacked; empty weeks are kept so gaps show
  const top = byProduct.slice(0, topProducts).map((p) => p.key);
  const weeks: Record<string, number>[] = [];
  if (rows.length) {
    const byWeek = new Map<number, Record<string, number>>();
    for (let w = monday(Date.parse(rows[0].ts)); w <= monday(Date.parse(rows.at(-1)!.ts)); w += 7 * DAY) byWeek.set(w, { t: w });
    for (const e of rows) {
      const w = byWeek.get(monday(Date.parse(e.ts)))!;
      const p = text(e.payload.product);
      const k = top.includes(p) ? p : "other";
      w[k] = (w[k] ?? 0) + 1;
      w._area = (w._area ?? 0) + num(e.payload.area);
    }
    let sum = 0;
    for (const w of byWeek.values()) {
      sum += w._area ?? 0;
      w._cum = Math.round(sum * 100) / 100;
      weeks.push(w);
    }
  }
  const weekIndex = new Map(weeks.map((w, i) => [w.t, i]));
  const matrix = bySubject.slice(0, 24).map((s) => ({ key: s.key, objectId: s.objectId!, cells: weeks.map(() => 0) }));
  const rowOf = new Map(matrix.map((m) => [m.objectId, m]));
  for (const e of rows) {
    const m = rowOf.get(e.objectId);
    if (m) m.cells[weekIndex.get(monday(Date.parse(e.ts)))!]++;
  }

  const signals: Signal[] = [];
  const doses: Analysis["doses"] = [];
  // a subject idle for more than twice its usual gap between entries (at least 3 entries to know it)
  for (const s of bySubject) {
    const ts = subjectTimes.get(s.objectId!) ?? [];
    if (ts.length < 3) continue;
    const usual = median(ts.slice(1).map((t, i) => (t - ts[i]) / DAY));
    const days = (now.getTime() - ts.at(-1)!) / DAY;
    if (usual >= 1 && days > 2 * usual) signals.push({ kind: "idle", objectId: s.objectId!, subject: s.key, days: Math.round(days), usual: Math.round(usual) });
  }
  // a dose far from the same product's median: beyond 3 MADs and at least half again or half less
  for (const p of byProduct) {
    const withDose = productDoses.get(p.key) ?? [];
    if (withDose.length < 3) continue;
    const values = withDose.map((e) => num(e.payload.dose));
    const m = median(values);
    const mad = median(values.map((d) => Math.abs(d - m))) || m * 0.1;
    for (const e of withDose) {
      const d = num(e.payload.dose);
      const odd = Math.abs(d - m) > 3 * mad && (d > m * 1.5 || d < m / 1.5);
      if (top.includes(p.key)) doses.push({ t: Date.parse(e.ts), dose: d, product: p.key, subject: e.subject, odd });
      if (odd)
        signals.push({ kind: "dose", objectId: e.objectId, subject: e.subject, product: p.key, ts: e.ts, dose: d, usual: m });
    }
  }
  // the same product on the same subject twice within two days
  const lastSeen = new Map<string, RecordEntry>();
  for (const e of rows) {
    const p = text(e.payload.product);
    if (!p) continue;
    const k = `${e.objectId}\u0000${p.toLowerCase()}`;
    const prev = lastSeen.get(k);
    if (prev) {
      const days = (Date.parse(e.ts) - Date.parse(prev.ts)) / DAY;
      if (days < 2) signals.push({ kind: "twice", objectId: e.objectId, subject: e.subject, product: p, ts: e.ts, days: Math.round(days * 10) / 10 });
    }
    lastSeen.set(k, e);
  }
  // most pressing first: wrong doses, then doubles, then the longest idle
  const rank = { dose: 0, twice: 1, idle: 2 };
  signals.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind === "idle" && b.kind === "idle" ? b.days - a.days : 0));

  return { partial, totals, weeks, products: [...top, ...(weeks.some((w) => w.other) ? ["other"] : [])], bySubject, byProduct, signals, matrix, doses };
}
