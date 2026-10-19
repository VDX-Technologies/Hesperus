// The overview's reading of the treatments: figures against the period before, crops by urgency, mixes.
import { describe, expect, it } from "vitest";
import { dashboard, periodFrom } from "../../lib/packages/agronomy/dashboard";
import type { CropInfo, RegisterRow } from "../../lib/packages/agronomy/register";

const now = new Date("2026-10-20T12:00:00Z");
const crop = (id: string, hectares: number, archived = false): CropInfo =>
  ({ id, name: id, species: id, variety: null, hectares, phase: "crescita", placeId: null, placePath: [], start: null, end: null, archived }) as CropInfo;
let n = 0;
const row = (cropId: string, date: string, q: number, unit: "L" | "kg" = "L", product = "Rame", adversity = "Peronospora"): RegisterRow =>
  ({ id: ++n, rootId: n, version: 1, date, cropId, crop: cropId, species: cropId, variety: null, place: "", areaHa: 2, phase: "crescita",
     adversity, product, quantity: { value: q, unit }, operator: null, notes: null, recordedBy: null, recordedAt: date }) as RegisterRow;

describe("agronomy dashboard", () => {
  const crops = [crop("vite", 4), crop("olivo", 3), crop("mais", 10), crop("old", 1, true)];
  const rows = [
    row("vite", "2026-10-18T08:00:00Z", 10),
    row("vite", "2026-10-10T08:00:00Z", 5, "kg", "Zolfo", "Oidio"),
    row("olivo", "2026-09-01T08:00:00Z", 4),
    row("vite", "2026-10-01T08:00:00Z", 6),
  ];

  it("reads the period's figures against the one before", () => {
    const d = dashboard(rows, crops, 30, now);
    expect(d.days).toHaveLength(30);
    expect(d.figures.treatments).toEqual({ value: 3, prev: 1 });
    expect(d.figures.liters.value).toBe(16);
    expect(d.figures.kilos.value).toBe(5);
    expect(d.figures.active).toEqual({ value: 1, prev: 1 });
    expect(d.figures.hectares).toBe(17);
  });

  it("puts crops never treated or overdue first", () => {
    const d = dashboard(rows, crops, 30, now);
    expect(d.crops.map((c) => [c.id, c.status])).toEqual([["mais", "never"], ["olivo", "due"], ["vite", "ok"]]);
    expect(d.figures.due).toBe(2);
    expect(d.crops[2].spark.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("keeps a running 7-day average and mixes products", () => {
    const d = dashboard(rows, crops, 7, now);
    expect(d.days.at(-1)!.t).toBe(Date.parse("2026-10-20T00:00:00Z"));
    expect(d.days.find((p) => p.n)!.ha).toBe(2);
    expect(d.products[0]).toMatchObject({ key: "Rame", n: 1, L: 10 });
    const all = dashboard(rows, crops, 0, now);
    expect(all.figures.treatments.prev).toBeNull();
    expect(all.products.map((p) => p.key)).toEqual(["Rame", "Zolfo"]);
  });

  it("defaults to 90 days", () => {
    expect(periodFrom(undefined)).toBe(90);
    expect(periodFrom("7")).toBe(7);
    expect(periodFrom("0")).toBe(0);
    expect(periodFrom("13")).toBe(90);
  });
});
