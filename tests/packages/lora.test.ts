import { describe, expect, it } from "vitest";
import { DEFAULTS, rulesFromConfig, loraPackage } from "../../lib/packages/lora";

const at = (min: number) => new Date(Date.UTC(2026, 9, 17, 10, min));
const run = (points: [number, Record<string, number>][]) => {
  const st: Record<string, unknown> = {};
  return points.map(([min, m]) => {
    const metrics: Record<string, number | null | undefined> = { ...m };
    loraPackage.step!(metrics, at(min), st);
    return metrics;
  });
};

describe("lora package", () => {
  it("normalizes a payload with an infrared frame", () => {
    const data = Array.from({ length: 64 }, (_, i) => (i < 4 ? 30 : 20));
    const n = loraPackage.normalize({ node_id: 7, temp_c: 20, rh: 80, ir_w: 8, ir_h: 8, ir: data, cfg_ver: 3 });
    if (Array.isArray(n)) throw new Error("one object expected");
    expect(n.object).toMatchObject({ type: "node", externalId: "7" });
    expect(n.metrics.leaf_c).toBe(20);
    expect(n.metrics.dew_c).toBeCloseTo(16.4, 1);
    expect(n.metrics.hot_area).toBe(6.3);
    expect(n.configAck).toBe(3);
    expect(() => loraPackage.normalize({ temp_c: 1 })).toThrow(/node_id/);
  });

  it("keeps what the node reports about its own hardware", () => {
    const n = loraPackage.normalize({ node_id: "heltec-a1", lux: 900, fw: "1.2.0", rssi: -61, sensors: { bh1750: true, mlx90614: false, "bad key": true, x: 1 } });
    if (Array.isArray(n)) throw new Error("one object expected");
    expect(n.object.properties).toEqual({ device: { fw: "1.2.0", rssi: -61, sensors: { bh1750: true, mlx90614: false } } });
    const old = loraPackage.normalize({ node_id: 7, temp_c: 20 });
    if (Array.isArray(old)) throw new Error("one object expected");
    expect(old.object.properties).toBeUndefined();
  });

  it("accumulates humid hours and resets them", () => {
    const hum = { rh: 92, temp_c: 18 };
    const out = run([[0, hum], [30, hum], [60, hum], [90, { rh: 70, temp_c: 18 }]]);
    expect(out.map((m) => m.humid_h)).toEqual([0, 0.5, 1, 0]);
  });

  it("pauses humidity rules during an irrigation boom and ignores late points", () => {
    const st: Record<string, unknown> = {};
    const step = (min: number, rh: number) => {
      const m: Record<string, number | null | undefined> = { rh, cond_margin: 0 };
      loraPackage.step!(m, at(min), st);
      return m;
    };
    expect(step(0, 60).rh_ctl).toBe(60);
    expect(step(1, 85).rh_ctl).toBeNull();
    expect(step(1 + DEFAULTS.irrigationHoldS / 60 + 1, 85).rh_ctl).toBe(85);
    const before = { ...st };
    step(0, 99);
    expect(st).toEqual(before);
  });

  it("turns thresholds into rule families", () => {
    const rules = rulesFromConfig({ tMax: 30, tMargin: 2 });
    expect(rules.find((r) => r.key === "temp_high")).toMatchObject({ threshold: 30, op: ">", push_to_device: true });
    expect(rules.find((r) => r.key === "temp_high_warn")!.threshold).toBe(28);
  });
});
