// The organization's operating picture: every register read together over a chosen period.
// Activity per register against the period before, a day-by-day series stacked by register,
// each object's cycle (sown, last treated, harvested, yield per hectare), where the work landed
// (object × register) and the signals worth a look. Pure: tests use it directly.
import type { Period } from "../packages/agronomy/dashboard";

const DAY = 86_400_000;
export const OVERDUE_DAYS = 21;

export interface OpsEvent {
  id: number;
  ts: number;
  type: string;
  objectIds: string[];
  payload: Record<string, unknown>;
}

export interface OpsObject {
  id: string;
  name: string;
  hectares: number | null;
  /** Objects that registers are about (crops); others only show up in the matrix. */
  tracked: boolean;
}

export interface Figure { value: number; prev: number | null }

export interface RegisterStat {
  type: string;
  n: Figure;
  ha: number;
  objects: number;
  last: number | null;
  /** Entries per bucket across the period, oldest first. */
  spark: number[];
}

export interface OpsDay { t: number; total: number; avg: number; [type: string]: number }

export interface Cycle {
  id: string;
  name: string;
  hectares: number | null;
  sown: number | null;
  treated: number | null;
  harvested: number | null;
  /** Treatments in the period. */
  treatments: number;
  /** Harvested kg in the period, and per hectare when the area is known. */
  yieldKg: number;
  yieldHa: number | null;
  /** Days since anything was recorded on it. */
  idle: number | null;
  status: "ok" | "due" | "never";
}

export type Signal =
  | { kind: "overdue"; objectId: string; name: string; days: number }
  | { kind: "never"; objectId: string; name: string }
  | { kind: "drop"; type: string; value: number; prev: number }
  | { kind: "silent"; type: string; prev: number }
  | { kind: "unharvested"; objectId: string; name: string; days: number };

export interface Ops {
  from: number;
  to: number;
  figures: { entries: Figure; area: Figure; objects: Figure; yieldKg: Figure; liters: Figure; kilos: Figure; hectares: number; due: number };
  registers: RegisterStat[];
  days: OpsDay[];
  cycles: Cycle[];
  matrix: { id: string; name: string; cells: Record<string, number>; total: number }[];
  signals: Signal[];
}

const startOfDay = (t: number) => t - (((t % DAY) + DAY) % DAY);
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const qty = (v: unknown): { value: number; unit: string } | null =>
  v && typeof v === "object" && typeof (v as { value?: unknown }).value === "number" ? (v as { value: number; unit: string }) : null;
const areaOf = (e: OpsEvent) => (typeof e.payload.area_ha === "number" ? e.payload.area_ha : 0);
const kgOf = (e: OpsEvent) => {
  const q = qty(e.payload.yield);
  return q ? (q.unit === "t" ? q.value * 1000 : q.value) : 0;
};
const amount = (e: OpsEvent, unit: "L" | "kg") => (qty(e.payload.quantity)?.unit === unit ? qty(e.payload.quantity)!.value : 0);
const is = (e: OpsEvent, key: string) => e.type.endsWith(`.${key}`);

function sum(rows: OpsEvent[]) {
  const objects = new Set<string>();
  let area = 0, yieldKg = 0, L = 0, kg = 0;
  for (const e of rows) {
    area += areaOf(e);
    if (is(e, "harvest")) yieldKg += kgOf(e);
    if (is(e, "treatment")) { L += amount(e, "L"); kg += amount(e, "kg"); }
    for (const o of e.objectIds) objects.add(o);
  }
  return { entries: rows.length, area: round(area), objects: objects.size, yieldKg: round(yieldKg), liters: round(L), kilos: round(kg) };
}

/** `types` in display order: every register the organization has, used or not. */
export function operations(events: OpsEvent[], types: string[], objects: OpsObject[], period: Period, now = new Date()): Ops {
  const end = startOfDay(now.getTime()) + DAY;
  const oldest = events.reduce((a, e) => Math.min(a, e.ts), end - DAY);
  const from = period ? end - period * DAY : startOfDay(oldest);
  const span = end - from;
  const inside = events.filter((e) => e.ts >= from && e.ts < end);
  const before = period ? events.filter((e) => e.ts >= from - span && e.ts < from) : null;
  const cur = sum(inside), prev = before && sum(before);
  const fig = (k: keyof typeof cur): Figure => ({ value: cur[k], prev: prev ? prev[k] : null });

  const buckets = Math.min(24, Math.max(1, Math.round(span / DAY)));
  const bucket = (t: number) => Math.min(buckets - 1, Math.floor(((t - from) / span) * buckets));
  const registers = types.map((type): RegisterStat => {
    const mine = inside.filter((e) => e.type === type);
    const spark = Array.from({ length: buckets }, () => 0);
    for (const e of mine) spark[bucket(e.ts)]++;
    const all = events.filter((e) => e.type === type);
    return {
      type,
      n: { value: mine.length, prev: before ? before.filter((e) => e.type === type).length : null },
      ha: round(mine.reduce((a, e) => a + areaOf(e), 0)),
      objects: new Set(mine.flatMap((e) => e.objectIds)).size,
      last: all.length ? Math.max(...all.map((e) => e.ts)) : null,
      spark,
    };
  });

  // one point per day, empty days kept so gaps read as gaps
  const days: OpsDay[] = [];
  const at = new Map<number, OpsDay>();
  for (let t = from; t < end; t += DAY) {
    const p: OpsDay = { t, total: 0, avg: 0 };
    for (const type of types) p[type] = 0;
    days.push(p);
    at.set(t, p);
  }
  for (const e of inside) {
    const p = at.get(startOfDay(e.ts));
    if (!p) continue;
    p[e.type] = (p[e.type] ?? 0) + 1;
    p.total++;
  }
  let run = 0;
  days.forEach((p, i) => {
    run += p.total - (i >= 7 ? days[i - 7].total : 0);
    p.avg = round(run / Math.min(7, i + 1));
  });

  // each tracked object's cycle, from all its history
  const byObject = new Map<string, OpsEvent[]>();
  for (const e of events) for (const o of e.objectIds) byObject.set(o, [...(byObject.get(o) ?? []), e]);
  const latest = (rows: OpsEvent[], key: string) => rows.reduce<number | null>((a, e) => (is(e, key) && (a === null || e.ts > a) ? e.ts : a), null);
  const ago = (t: number | null) => (t === null ? null : Math.max(0, Math.floor((now.getTime() - t) / DAY)));
  const cycles = objects
    .filter((o) => o.tracked)
    .map((o): Cycle => {
      const mine = byObject.get(o.id) ?? [];
      const here = mine.filter((e) => e.ts >= from && e.ts < end);
      const treated = latest(mine, "treatment");
      const yieldKg = round(here.filter((e) => is(e, "harvest")).reduce((a, e) => a + kgOf(e), 0));
      const lastAny = mine.length ? Math.max(...mine.map((e) => e.ts)) : null;
      const sinceTreat = ago(treated);
      return {
        id: o.id, name: o.name, hectares: o.hectares,
        sown: latest(mine, "sowing") ?? latest(mine, "transplant"), treated, harvested: latest(mine, "harvest"),
        treatments: here.filter((e) => is(e, "treatment")).length,
        yieldKg, yieldHa: o.hectares && yieldKg ? round(yieldKg / o.hectares, 1) : null,
        idle: ago(lastAny),
        status: sinceTreat === null ? "never" : sinceTreat > OVERDUE_DAYS ? "due" : "ok",
      };
    })
    .sort((a, b) => (b.idle ?? Infinity) - (a.idle ?? Infinity) || a.name.localeCompare(b.name));

  // where the work landed: the busiest objects in the period, by register
  const names = new Map(objects.map((o) => [o.id, o.name]));
  const cells = new Map<string, Record<string, number>>();
  for (const e of inside) for (const o of e.objectIds) {
    const c = cells.get(o) ?? {};
    c[e.type] = (c[e.type] ?? 0) + 1;
    cells.set(o, c);
  }
  const matrix = [...cells]
    .map(([id, c]) => ({ id, name: names.get(id) ?? id.slice(0, 8), cells: c, total: Object.values(c).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .slice(0, 14);

  const signals: Signal[] = [];
  for (const r of registers) {
    if (r.n.prev === null || r.n.prev < 5) continue;
    if (r.n.value === 0) signals.push({ kind: "silent", type: r.type, prev: r.n.prev });
    else if (r.n.value <= r.n.prev / 2) signals.push({ kind: "drop", type: r.type, value: r.n.value, prev: r.n.prev });
  }
  for (const c of cycles) {
    if (c.status === "never") signals.push({ kind: "never", objectId: c.id, name: c.name });
    else if (c.status === "due") signals.push({ kind: "overdue", objectId: c.id, name: c.name, days: ago(c.treated)! });
    // sown long ago and never harvested since
    if (c.sown !== null && (c.harvested === null || c.harvested < c.sown) && ago(c.sown)! > 240)
      signals.push({ kind: "unharvested", objectId: c.id, name: c.name, days: ago(c.sown)! });
  }

  const tracked = cycles.reduce((a, c) => a + (c.hectares ?? 0), 0);
  return {
    from, to: end,
    figures: {
      entries: fig("entries"), area: fig("area"), objects: fig("objects"), yieldKg: fig("yieldKg"), liters: fig("liters"), kilos: fig("kilos"),
      hectares: round(tracked), due: cycles.filter((c) => c.status !== "ok").length,
    },
    registers, days, cycles, matrix, signals,
  };
}
