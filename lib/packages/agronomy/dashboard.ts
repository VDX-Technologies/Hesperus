import type { CropInfo, RegisterRow } from "./register";

const DAY = 86_400_000;

export const PERIODS = [7, 30, 90, 365, 0] as const;
export type Period = (typeof PERIODS)[number];
export const periodFrom = (v: unknown): Period => (PERIODS.includes(Number(v) as Period) && v !== "" ? (Number(v) as Period) : 30);

export const OVERDUE_DAYS = 21;

export interface Figure {
  value: number;
  prev: number | null;
}

export interface DayPoint {
  t: number;
  n: number;
  ha: number;
  L: number;
  kg: number;
  avg: number;
}

export interface CropState {
  id: string;
  name: string;
  hectares: number | null;
  phase: string | null;
  last: string | null;
  days: number | null;
  inPeriod: number;
  ha: number;
  status: "ok" | "due" | "never";
  spark: number[];
}

export interface Mix {
  key: string;
  n: number;
  L: number;
  kg: number;
}

export interface Dashboard {
  from: number;
  to: number;
  figures: { treatments: Figure; area: Figure; liters: Figure; kilos: Figure; active: Figure; due: number; hectares: number };
  days: DayPoint[];
  crops: CropState[];
  products: Mix[];
  adversities: Mix[];
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
};

const amount = (r: RegisterRow, unit: "L" | "kg") => (r.quantity?.unit === unit ? r.quantity.value : 0);
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function sum(rows: RegisterRow[]) {
  const crops = new Set<string>();
  let area = 0, L = 0, kg = 0;
  for (const r of rows) {
    area += r.areaHa ?? 0;
    L += amount(r, "L");
    kg += amount(r, "kg");
    if (r.cropId) crops.add(r.cropId);
  }
  return { treatments: rows.length, area: round(area), liters: round(L), kilos: round(kg), active: crops.size };
}

function mix(rows: RegisterRow[], key: (r: RegisterRow) => string, top = 8): Mix[] {
  const m = new Map<string, Mix>();
  for (const r of rows) {
    const k = key(r).trim() || "–";
    const x = m.get(k) ?? { key: k, n: 0, L: 0, kg: 0 };
    x.n++;
    x.L = round(x.L + amount(r, "L"));
    x.kg = round(x.kg + amount(r, "kg"));
    m.set(k, x);
  }
  return [...m.values()].sort((a, b) => b.n - a.n).slice(0, top);
}

export function dashboard(rows: RegisterRow[], crops: CropInfo[], period: Period, now = new Date()): Dashboard {
  const end = startOfDay(now.getTime()) + DAY;
  const oldest = rows.reduce((a, r) => Math.min(a, Date.parse(r.date)), end - DAY);
  const from = period ? end - period * DAY : startOfDay(oldest);
  const span = end - from;
  const inside = rows.filter((r) => { const t = Date.parse(r.date); return t >= from && t < end; });
  const before = period ? rows.filter((r) => { const t = Date.parse(r.date); return t >= from - span && t < from; }) : null;
  const cur = sum(inside), prev = before && sum(before);
  const fig = (k: keyof typeof cur): Figure => ({ value: cur[k], prev: prev ? prev[k] : null });

  const days: DayPoint[] = [];
  const at = new Map<number, DayPoint>();
  for (let t = from; t < end; t += DAY) {
    const p = { t, n: 0, ha: 0, L: 0, kg: 0, avg: 0 };
    days.push(p);
    at.set(t, p);
  }
  for (const r of inside) {
    const p = at.get(startOfDay(Date.parse(r.date)));
    if (!p) continue;
    p.n++;
    p.ha = round(p.ha + (r.areaHa ?? 0));
    p.L = round(p.L + amount(r, "L"));
    p.kg = round(p.kg + amount(r, "kg"));
  }
  let run = 0;
  days.forEach((p, i) => {
    run += p.n - (i >= 7 ? days[i - 7].n : 0);
    p.avg = round(run / Math.min(7, i + 1));
  });

  const buckets = Math.min(24, Math.max(1, Math.round(span / DAY)));
  const size = span / buckets;
  const lastOn = new Map<string, string>();
  for (const r of rows) if (r.cropId && (!lastOn.has(r.cropId) || r.date > lastOn.get(r.cropId)!)) lastOn.set(r.cropId, r.date);
  const state = crops
    .filter((c) => !c.archived)
    .map((c): CropState => {
      const mine = inside.filter((r) => r.cropId === c.id);
      const spark = Array.from({ length: buckets }, () => 0);
      for (const r of mine) spark[Math.min(buckets - 1, Math.floor((Date.parse(r.date) - from) / size))]++;
      const last = lastOn.get(c.id) ?? null;
      const days = last ? Math.max(0, Math.floor((now.getTime() - Date.parse(last)) / DAY)) : null;
      return {
        id: c.id, name: c.name, hectares: c.hectares, phase: c.phase, last, days,
        inPeriod: mine.length, ha: round(mine.reduce((a, r) => a + (r.areaHa ?? 0), 0)),
        status: days === null ? "never" : days > OVERDUE_DAYS ? "due" : "ok", spark,
      };
    })
    .sort((a, b) => (b.days ?? Infinity) - (a.days ?? Infinity) || a.name.localeCompare(b.name));

  return {
    from,
    to: end,
    figures: {
      treatments: fig("treatments"), area: fig("area"), liters: fig("liters"), kilos: fig("kilos"), active: fig("active"),
      due: state.filter((c) => c.status !== "ok").length,
      hectares: round(state.reduce((a, c) => a + (c.hectares ?? 0), 0)),
    },
    days,
    crops: state,
    products: mix(inside, (r) => r.product),
    adversities: mix(inside, (r) => r.adversity),
  };
}
