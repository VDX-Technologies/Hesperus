// The overview's operating picture: every register together, cycles per crop, matrix and signals.
import { describe, expect, it } from "vitest";
import { operations, type OpsEvent, type OpsObject } from "../../lib/engine/ops";

const now = new Date("2026-10-20T12:00:00Z");
const TYPES = ["agronomy.treatment", "agronomy.sowing", "agronomy.harvest", "custom.pruning"];
const objects: OpsObject[] = [
  { id: "a", name: "Vigna", hectares: 2, tracked: true },
  { id: "b", name: "Mais", hectares: 4, tracked: true },
  { id: "c", name: "Orzo", hectares: 1, tracked: true },
];
let n = 0;
const ev = (type: string, date: string, obj: string, payload: Record<string, unknown> = {}): OpsEvent =>
  ({ id: ++n, ts: Date.parse(date), type, objectIds: [obj], payload });

describe("operations", () => {
  const events = [
    ev("agronomy.sowing", "2026-03-01T08:00:00Z", "b", { area_ha: 4 }),
    ev("agronomy.treatment", "2026-10-15T08:00:00Z", "a", { area_ha: 2, quantity: { value: 6, unit: "L" } }),
    ev("agronomy.treatment", "2026-10-10T08:00:00Z", "a", { area_ha: 2, quantity: { value: 3, unit: "kg" } }),
    ev("agronomy.treatment", "2026-08-01T08:00:00Z", "b", { area_ha: 4 }),
    ev("agronomy.harvest", "2026-10-18T08:00:00Z", "a", { area_ha: 2, yield: { value: 9, unit: "t" } }),
    ev("custom.pruning", "2026-10-19T08:00:00Z", "a"),
    ...Array.from({ length: 6 }, (_, i) => ev("custom.pruning", `2026-09-1${i}T08:00:00Z`, "c")),
  ];
  const o = operations(events, TYPES, objects, 30, now);

  it("counts every register in the period against the one before", () => {
    expect(o.figures.entries).toEqual({ value: 4, prev: 6 });
    expect(o.figures.yieldKg.value).toBe(9000);
    expect(o.figures.liters.value).toBe(6);
    expect(o.figures.kilos.value).toBe(3);
    expect(o.figures.area.value).toBe(4); // treated area only
    expect(o.registers.map((r) => [r.type, r.n.value])).toEqual([
      ["agronomy.treatment", 2], ["agronomy.sowing", 0], ["agronomy.harvest", 1], ["custom.pruning", 1],
    ]);
    expect(o.days).toHaveLength(30);
    expect(o.days.reduce((a, d) => a + d.total, 0)).toBe(4);
    expect(o.days.at(-2)!["custom.pruning"]).toBe(1);
  });

  it("follows each crop through its cycle", () => {
    const vigna = o.cycles.find((c) => c.id === "a")!;
    expect(vigna).toMatchObject({ treatments: 2, yieldKg: 9000, yieldHa: 4500, status: "ok", idle: 1 });
    const mais = o.cycles.find((c) => c.id === "b")!;
    expect(mais).toMatchObject({ status: "due", sown: Date.parse("2026-03-01T08:00:00Z"), harvested: null });
    expect(o.cycles.find((c) => c.id === "c")!.status).toBe("never");
    expect(o.figures.due).toBe(2);
    expect(o.figures.hectares).toBe(7);
  });

  it("maps the work by object and register, and raises signals", () => {
    expect(o.matrix[0]).toMatchObject({ id: "a", total: 4, cells: { "agronomy.treatment": 2, "agronomy.harvest": 1, "custom.pruning": 1 } });
    expect(o.signals).toEqual(expect.arrayContaining([
      { kind: "drop", type: "custom.pruning", value: 1, prev: 6 },
      { kind: "overdue", objectId: "b", name: "Mais", days: 80 },
      { kind: "never", objectId: "c", name: "Orzo" },
    ]));
    // sown 233 days ago: not yet a missing harvest
    expect(o.signals.some((s) => s.kind === "unharvested")).toBe(false);
  });

  it("reads all history with no comparison when the period is all", () => {
    const all = operations(events, TYPES, objects, 0, now);
    expect(all.figures.entries).toEqual({ value: events.length, prev: null });
    expect(all.from).toBe(Date.parse("2026-03-01T00:00:00Z"));
  });
});
