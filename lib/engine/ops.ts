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
  tracked: boolean;
}

export interface Figure { value: number; prev: number | null }

export interface RegisterStat {
  type: string;
  n: Figure;
  ha: number;
  objects: number;
  last: number | null;
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
  treatments: number;
  yieldKg: number;
  yieldHa: number | null;
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

type Totals = { entries: number; area: number; objects: Set<string>; yieldKg: number; liters: number; kilos: number };
type TypeTotals = { entries: number; area: number; objects: Set<string> };
type CropTotals = { treatments: number; yieldKg: number };

const startOfDay = (t: number) => t - (((t % DAY) + DAY) % DAY);
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const totals = (): Totals => ({ entries: 0, area: 0, objects: new Set(), yieldKg: 0, liters: 0, kilos: 0 });
const qty = (v: unknown): { value: number; unit: string } | null =>
  v && typeof v === "object" && typeof (v as { value?: unknown }).value === "number" ? (v as { value: number; unit: string }) : null;
const areaOf = (e: OpsEvent) => (typeof e.payload.area_ha === "number" ? e.payload.area_ha : 0);
const kgOf = (e: OpsEvent) => {
  const q = qty(e.payload.yield);
  return q ? (q.unit === "t" ? q.value * 1000 : q.value) : 0;
};
const amount = (e: OpsEvent, unit: "L" | "kg") => (qty(e.payload.quantity)?.unit === unit ? qty(e.payload.quantity)!.value : 0);
const is = (e: OpsEvent, key: string) => e.type.endsWith(`.${key}`);

export class OperationsAccumulator {
  private readonly end: number;
  private readonly currentFrom: number | null;
  private readonly previousFrom: number | null;
  private readonly current = totals();
  private readonly previous = totals();
  private readonly currentTypes = new Map<string, TypeTotals>();
  private readonly previousTypes = new Map<string, TypeTotals>();
  private readonly daily = new Map<number, Map<string, number>>();
  private readonly currentByObject = new Map<string, CropTotals>();
  private readonly matrixCells = new Map<string, Map<string, number>>();
  private readonly latestByObjectType = new Map<string, Map<string, OpsEvent>>();
  private readonly lastByType = new Map<string, number>();
  private oldest = Infinity;

  constructor(
    private readonly types: string[],
    private readonly objects: OpsObject[],
    private readonly period: Period,
    private readonly now = new Date(),
  ) {
    this.end = startOfDay(now.getTime()) + DAY;
    this.currentFrom = period ? this.end - period * DAY : null;
    this.previousFrom = period ? this.currentFrom! - period * DAY : null;
    for (const type of types) {
      this.currentTypes.set(type, { entries: 0, area: 0, objects: new Set() });
      this.previousTypes.set(type, { entries: 0, area: 0, objects: new Set() });
    }
  }

  push(e: OpsEvent) {
    this.oldest = Math.min(this.oldest, e.ts);
    this.setLatestType(e.type, e.ts);
    const inCurrent = e.ts < this.end && (this.currentFrom === null || e.ts >= this.currentFrom);
    if (inCurrent) {
      this.addPeriodEvent(this.current, this.currentTypes, e);
      const day = startOfDay(e.ts);
      let values = this.daily.get(day);
      if (!values) this.daily.set(day, (values = new Map()));
      values.set(e.type, (values.get(e.type) ?? 0) + 1);
      for (const id of e.objectIds) {
        if (is(e, "treatment") || is(e, "harvest")) {
          let crop = this.currentByObject.get(id);
          if (!crop) this.currentByObject.set(id, (crop = { treatments: 0, yieldKg: 0 }));
          if (is(e, "treatment")) crop.treatments++;
          if (is(e, "harvest")) crop.yieldKg += kgOf(e);
        }
        let cells = this.matrixCells.get(id);
        if (!cells) this.matrixCells.set(id, (cells = new Map()));
        cells.set(e.type, (cells.get(e.type) ?? 0) + 1);
      }
    } else if (this.previousFrom !== null && e.ts >= this.previousFrom && e.ts < this.currentFrom!) {
      this.addPeriodEvent(this.previous, this.previousTypes, e);
    }
  }

  addHistory(e: OpsEvent) {
    this.setLatestType(e.type, e.ts);
    for (const id of e.objectIds) {
      let byType = this.latestByObjectType.get(id);
      if (!byType) this.latestByObjectType.set(id, (byType = new Map()));
      const prior = byType.get(e.type);
      if (!prior || e.ts > prior.ts || (e.ts === prior.ts && e.id > prior.id)) byType.set(e.type, e);
    }
  }

  setLatestType(type: string, ts: number) {
    if (ts > (this.lastByType.get(type) ?? -Infinity)) this.lastByType.set(type, ts);
  }

  private addPeriodEvent(all: Totals, byType: Map<string, TypeTotals>, e: OpsEvent) {
    all.entries++;
    if (is(e, "treatment")) all.area += areaOf(e);
    if (is(e, "harvest")) all.yieldKg += kgOf(e);
    if (is(e, "treatment")) { all.liters += amount(e, "L"); all.kilos += amount(e, "kg"); }
    for (const id of e.objectIds) all.objects.add(id);

    const stat = byType.get(e.type);
    if (stat) {
      stat.entries++;
      stat.area += areaOf(e);
      for (const id of e.objectIds) stat.objects.add(id);
    }
  }

  finish(): Ops {
    const from = this.currentFrom ?? (Number.isFinite(this.oldest) ? startOfDay(this.oldest) : this.end - DAY);
    const span = Math.max(DAY, this.end - from);
    const buckets = Math.min(24, Math.max(1, Math.round(span / DAY)));
    const sparkByType = new Map(this.types.map((type) => [type, Array.from({ length: buckets }, () => 0)]));
    for (const [day, values] of this.daily) {
      if (day < from || day >= this.end) continue;
      const i = Math.min(buckets - 1, Math.max(0, Math.floor(((day - from) / span) * buckets)));
      for (const [type, count] of values) {
        const spark = sparkByType.get(type);
        if (spark) spark[i] += count;
      }
    }

    const fig = (key: keyof Omit<Totals, "objects"> | "objects"): Figure => {
      const value = key === "objects" ? this.current.objects.size : this.current[key];
      const prev = key === "objects" ? this.previous.objects.size : this.previous[key];
      return { value: typeof value === "number" ? round(value) : value, prev: this.period ? (typeof prev === "number" ? round(prev) : prev) : null };
    };
    const registers: RegisterStat[] = this.types.map((type) => {
      const cur = this.currentTypes.get(type)!;
      const prev = this.previousTypes.get(type)!;
      return {
        type,
        n: { value: cur.entries, prev: this.period ? prev.entries : null },
        ha: round(cur.area),
        objects: cur.objects.size,
        last: this.lastByType.get(type) ?? null,
        spark: sparkByType.get(type)!,
      };
    });

    const days: OpsDay[] = [];
    let run = 0;
    for (let t = from; t < this.end; t += DAY) {
      const values = this.daily.get(t) ?? new Map<string, number>();
      const total = this.types.reduce((n, type) => n + (values.get(type) ?? 0), 0);
      run += total - (days.length >= 7 ? days[days.length - 7].total : 0);
      const p: OpsDay = { t, total, avg: round(run / Math.min(7, days.length + 1)) };
      for (const type of this.types) p[type] = values.get(type) ?? 0;
      days.push(p);
    }

    const ago = (t: number | null) => (t === null ? null : Math.max(0, Math.floor((this.now.getTime() - t) / DAY)));
    const latest = (byType: Map<string, OpsEvent> | undefined, key: string) => {
      let at: number | null = null;
      for (const e of byType?.values() ?? []) if (is(e, key) && (at === null || e.ts > at)) at = e.ts;
      return at;
    };
    const cycles = this.objects.filter((o) => o.tracked).map((o): Cycle => {
      const history = this.latestByObjectType.get(o.id);
      const sownValues = [latest(history, "sowing"), latest(history, "transplant")].filter((x): x is number => x !== null);
      const sown = sownValues.length ? Math.max(...sownValues) : null;
      const treated = latest(history, "treatment");
      const harvested = latest(history, "harvest");
      let lastAny: number | null = null;
      for (const e of history?.values() ?? []) if (lastAny === null || e.ts > lastAny) lastAny = e.ts;
      const crop = this.currentByObject.get(o.id) ?? { treatments: 0, yieldKg: 0 };
      const sinceTreat = ago(treated);
      return {
        id: o.id, name: o.name, hectares: o.hectares, sown, treated, harvested,
        treatments: crop.treatments,
        yieldKg: round(crop.yieldKg),
        yieldHa: o.hectares && crop.yieldKg ? round(crop.yieldKg / o.hectares, 1) : null,
        idle: ago(lastAny),
        status: sinceTreat === null ? "never" : sinceTreat > OVERDUE_DAYS ? "due" : "ok",
      };
    }).sort((a, b) => (b.idle ?? Infinity) - (a.idle ?? Infinity) || a.name.localeCompare(b.name));

    const names = new Map(this.objects.map((o) => [o.id, o.name]));
    const matrix = [...this.matrixCells]
      .map(([id, cells]) => {
        const row = Object.fromEntries(cells);
        return { id, name: names.get(id) ?? id.slice(0, 8), cells: row, total: Object.values(row).reduce((a, b) => a + b, 0) };
      })
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
      if (c.sown !== null && (c.harvested === null || c.harvested < c.sown) && ago(c.sown)! > 240)
        signals.push({ kind: "unharvested", objectId: c.id, name: c.name, days: ago(c.sown)! });
    }

    return {
      from,
      to: this.end,
      figures: {
        entries: fig("entries"), area: fig("area"), objects: fig("objects"), yieldKg: fig("yieldKg"), liters: fig("liters"), kilos: fig("kilos"),
        hectares: round(cycles.reduce((a, c) => a + (c.hectares ?? 0), 0)),
        due: cycles.filter((c) => c.status !== "ok").length,
      },
      registers,
      days,
      cycles,
      matrix,
      signals,
    };
  }
}

export function operations(events: OpsEvent[], types: string[], objects: OpsObject[], period: Period, now = new Date()): Ops {
  const accumulator = new OperationsAccumulator(types, objects, period, now);
  for (const e of events) accumulator.push(e);
  for (const e of events) accumulator.addHistory(e);
  return accumulator.finish();
}
