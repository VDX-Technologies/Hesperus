import { describe, expect, it } from "vitest";
import { classify, unitOf } from "../../lib/packages/agronomy/import";

const rows = (...r: Record<string, string>[]) => r;

describe("agronomy import", () => {
  it("tells treatments, harvests and sowings from the rows", () => {
    expect(classify(rows({ subject: "Vigna", product: "Rame", dose: "2" }, { subject: "Uliveto", product: "Zolfo", adversity: "oidio" }))).toBe("treatment");
    expect(classify(rows({ subject: "Vigna", quantity: "1200" }, { subject: "Uliveto", quantity: "900" }))).toBe("harvest");
    expect(classify(rows({ subject: "Mais", product: "P1547" }), "semina 2026.csv")).toBe("sowing");
    expect(classify(rows({ subject: "Vigna", kind: "Trattamento fungicida" }))).toBe("treatment");
  });

  it("leaves a file that is not agronomy work, or mixed, as it is", () => {
    expect(classify(rows({ subject: "Pompa 1", note: "ok" }, { subject: "Pompa 2", note: "ok" }))).toBeNull();
    expect(classify(rows({ subject: "A", product: "Rame", dose: "2" }, { subject: "B", quantity: "9" }, { subject: "C", note: "x" }))).toBeNull();
    expect(classify(rows({ product: "Rame", dose: "2" }))).toBeNull();
  });

  it("reads units from headers and unit columns", () => {
    expect(unitOf("Dose (l/ha)")).toBe("L");
    expect(unitOf("kg/ha")).toBe("kg");
    expect(unitOf("Qli")).toBe("kg");
    expect(unitOf("t")).toBe("t");
    expect(unitOf("", "kg")).toBe("kg");
  });
});
