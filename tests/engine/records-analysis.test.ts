import { describe, expect, it } from "vitest";
import { analyze } from "../../lib/packages/records/analysis";

let n = 0;
const entry = (day: string, subject: string, payload: Record<string, unknown> = {}) => ({
  id: String(++n), ts: `${day}T08:00:00.000Z`, objectId: `o-${subject}`, subject, payload,
});

describe("records analysis", () => {
  it("adds up totals, shares and weeks with gaps kept", () => {
    const a = analyze([
      entry("2026-09-01", "Vigna", { product: "Rame", dose: 2, area: 1.5 }),
      entry("2026-09-02", "Vigna", { product: "Zolfo", dose: 3, area: 1.5 }),
      entry("2026-09-20", "Uliveto", { product: "Rame", dose: 2.5, area: 2 }),
    ], new Date("2026-09-21"));
    expect(a.totals).toMatchObject({ entries: 3, subjects: 2, products: 2, area: 5, first: "2026-09-01T08:00:00.000Z" });
    expect(a.bySubject[0]).toMatchObject({ key: "Vigna", entries: 2, area: 3 });
    expect(a.byProduct[0].key).toBe("Rame");
    expect(a.weeks.length).toBe(3);
    expect(a.weeks[1]).toEqual({ t: Date.parse("2026-09-07"), _cum: 3 });
    expect(a.matrix[0]).toMatchObject({ key: "Vigna", cells: [2, 0, 0] });
    expect(a.products).toEqual(["Rame", "Zolfo"]);
  });

  it("flags an idle subject, an odd dose and an entry recorded twice", () => {
    const rows = [
      ...["2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22"].map((d) => entry(d, "Vigna", { product: "Rame", dose: 2 })),
      entry("2026-09-25", "Uliveto", { product: "Rame", dose: 9 }),
      entry("2026-09-25", "Uliveto", { product: "Zolfo", dose: 3 }),
      entry("2026-09-26", "Uliveto", { product: "zolfo ", dose: 3 }),
    ];
    const s = analyze(rows, new Date("2026-09-30")).signals;
    expect(s.map((x) => x.kind)).toEqual(["dose", "twice", "idle"]);
    expect(s[0]).toMatchObject({ subject: "Uliveto", dose: 9, usual: 2 });
    expect(s[2]).toMatchObject({ subject: "Vigna", usual: 7, days: 39 });
  });

  it("stays quiet on regular work", () => {
    const rows = ["2026-09-01", "2026-09-08", "2026-09-15"].map((d) => entry(d, "Vigna", { product: "Rame", dose: 2 }));
    expect(analyze(rows, new Date("2026-09-18")).signals).toEqual([]);
    expect(analyze([]).weeks).toEqual([]);
  });
});
