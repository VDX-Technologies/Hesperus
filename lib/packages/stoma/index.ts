// Stoma as a module package: greenhouse climate nodes behind a LoRa gateway.
// normalize() turns one gateway payload into node metrics (the physics is shared with the
// legacy module); step() carries the counters that need hours of history (leaf wetness,
// botrytis and mildew risk, irrigation pauses) in the node's package state. Alarms are plain
// engine rules over these metrics, built from the customer's thresholds by rulesFromConfig().
import { ValidationError, type ModulePackage } from "../../engine/package";
import type { RuleSpec } from "../../engine/rules";
import { dewPoint, irFrame, luxToPar, stoma as legacy, vpd, type StomaConfig } from "../../modules/stoma";

export type { StomaConfig };
export const DEFAULTS: StomaConfig = legacy.defaultConfig;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const round = (v: number | null, d: number) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const inMildRange = (t: number | null | undefined) => typeof t === "number" && t >= 10 && t <= 25;

/** Counters need hours of history; these are fixed so step() does not depend on rules. */
const WET_MARGIN = DEFAULTS.leafDewAlarm;
const HOTSPOT_DELTA = DEFAULTS.hotspotDelta;

const HELPERS = [
  { key: "rh_ctl", unit: "%", label: { en: "Humidity (outside irrigation)", it: "Umidità (fuori irrigazione)" } },
  { key: "cond_ctl", unit: "°C", label: { en: "Condensation margin (outside irrigation)", it: "Margine condensa (fuori irrigazione)" } },
  { key: "humid_h", unit: "h", label: { en: "Hours humid and mild", it: "Ore umide e miti" } },
  { key: "downy_h", unit: "h", label: { en: "Hours wet and mild", it: "Ore bagnate e miti" } },
  { key: "stress_day", unit: "°C", label: { en: "Leaf − air in daylight", it: "Foglia − aria con luce" } },
  { key: "hot_area", unit: "%", label: { en: "Infrared hot area", it: "Area calda infrarossa" } },
];

export const stomaPackage: ModulePackage = {
  id: "stoma",
  objectTypes: [{
    key: "node",
    name: { en: "Stoma node", it: "Nodo Stoma" },
    properties: { ir: { type: "object" }, zone_id: { type: "string" } },
  }],
  metrics: [...legacy.metrics.map((m) => ({ key: m.key, unit: m.unit, label: m.label })), ...HELPERS],

  normalize(p) {
    const id = p.node_id;
    if (typeof id !== "number" && typeof id !== "string") throw new ValidationError("node_id is required");
    const t = num(p.temp_c), rh = num(p.rh), lux = num(p.lux);
    const frame = irFrame(p);
    const leaf = num(p.leaf_c) ?? (frame ? median(frame.data) : null);
    const dew = t !== null && rh !== null ? dewPoint(t, rh) : null;
    const margin = leaf !== null && dew !== null ? leaf - dew : null;
    let irSpread: number | null = null, hotArea: number | null = null;
    if (frame) {
      const med = median(frame.data);
      irSpread = pct(frame.data, 95) - pct(frame.data, 5);
      hotArea = (100 * frame.data.filter((x) => x - med >= HOTSPOT_DELTA).length) / frame.data.length;
    }
    return {
      object: {
        type: "node",
        externalId: String(id),
        properties: frame ? { ir: { w: frame.w, h: frame.h, data: frame.data.map((x) => Math.round(x * 10) / 10) } } : undefined,
      },
      metrics: {
        temp_c: round(t, 2),
        rh: round(rh, 1),
        leaf_c: round(leaf, 2),
        dew_c: round(dew, 2),
        cond_margin: round(margin, 2),
        vpd_kpa: t !== null && rh !== null ? round(vpd(t, rh, leaf), 3) : null,
        co2: round(num(p.co2), 0),
        voc: round(num(p.voc), 0),
        lux: round(lux, 0),
        par: lux !== null ? round(luxToPar(lux), 0) : null,
        uvi: round(num(p.uvi), 2),
        leaf_air: leaf !== null && t !== null ? round(leaf - t, 2) : null,
        ir_spread: round(irSpread, 2),
        hot_area: round(hotArea, 1),
      },
      configAck: num(p.cfg_ver) ?? undefined,
    };
  },

  step(m, ts, st) {
    const now = ts.getTime();
    const prevTs = num(st.ts);
    if (prevTs !== null && now <= prevTs) return; // late point: no counters, state untouched
    const rh = m.rh ?? null, t = m.temp_c ?? null, margin = m.cond_margin ?? null;

    // A sudden humidity jump is an irrigation boom: humidity and condensation rules pause.
    let until = num(st.irrigation_until) ?? 0;
    const prevRh = num(st.rh);
    if (rh !== null && prevRh !== null && rh - prevRh >= DEFAULTS.irrigationJump) until = now + DEFAULTS.irrigationHoldS * 1000;
    const irrigating = until > now;
    m.rh_ctl = irrigating ? null : rh;
    m.cond_ctl = irrigating ? null : margin;

    // Hours since the previous point, capped so a data gap does not count as hours of risk.
    const dtH = prevTs !== null ? Math.min(1, (now - prevTs) / 3600000) : 0;
    const wet = (margin !== null && margin <= WET_MARGIN) || (rh !== null && rh >= 97);
    const wetH = wet ? (num(st.wet_h) ?? 0) + dtH : 0;
    const humidH = rh !== null && rh >= 90 && inMildRange(t) ? (num(st.humid_h) ?? 0) + dtH : 0;
    // Powdery mildew, simplified Gubler-Thomas: a day with >= 6 h at 21-30 °C adds 20, else -10.
    const day = ts.toISOString().slice(0, 10);
    let base = num(st.pm_base) ?? 0, hours = num(st.pm_hours) ?? 0;
    if (typeof st.pm_day === "string" && st.pm_day !== day) {
      base = Math.min(100, Math.max(0, base + (hours >= 6 ? 20 : -10)));
      hours = 0;
    }
    if (t !== null && t >= 21 && t <= 30) hours += dtH;

    m.wet_h = round(wetH, 2);
    m.humid_h = round(humidH, 2);
    m.downy_h = inMildRange(t) ? round(wetH, 2) : 0;
    m.pm_index = Math.min(100, base + (hours >= 6 ? 20 : 0));
    const leafAir = m.leaf_air ?? null;
    m.stress_day = leafAir === null ? null : (m.lux ?? 0) > 10000 ? leafAir : 0;

    Object.assign(st, {
      ts: now, rh, wet_h: wetH, humid_h: humidH, pm_day: day, pm_base: base, pm_hours: hours,
      irrigation_until: irrigating ? until : null,
    });
  },
};

/**
 * The customer's thresholds as engine rules. Warning and alarm levels are separate families
 * (`<code>_warn` and `<code>`); the climate ones are also pushed to the node's status ring.
 */
export function rulesFromConfig(c: Partial<StomaConfig>): RuleSpec[] {
  const k = { ...DEFAULTS, ...c };
  const r = (key: string, metric: string, op: RuleSpec["op"], threshold: number, severity: RuleSpec["severity"], push = false): RuleSpec =>
    ({ key, name: key, metric, object_type: "node", op, threshold, severity, push_to_device: push });
  return [
    r("temp_high", "temp_c", ">", k.tMax, "alarm", true),
    r("temp_high_warn", "temp_c", ">", k.tMax - k.tMargin, "warn", true),
    r("temp_low", "temp_c", "<", k.tMin, "alarm", true),
    r("temp_low_warn", "temp_c", "<", k.tMin + k.tMargin, "warn", true),
    r("rh_high", "rh_ctl", ">", k.rhMax, "alarm", true),
    r("rh_high_warn", "rh_ctl", ">", k.rhMax - k.rhMargin, "warn", true),
    r("rh_low", "rh_ctl", "<", k.rhMin, "alarm", true),
    r("rh_low_warn", "rh_ctl", "<", k.rhMin + k.rhMargin, "warn", true),
    r("condensation", "cond_ctl", "<=", k.leafDewAlarm, "alarm", true),
    r("condensation_warn", "cond_ctl", "<=", k.leafDewWarn, "warn", true),
    r("co2_low", "co2", "<", k.co2LowWarn, "warn", true),
    r("botrytis_warn", "humid_h", ">=", k.botrytisHours, "warn"),
    r("botrytis", "humid_h", ">=", 2 * k.botrytisHours, "alarm"),
    r("downy_mildew_warn", "downy_h", ">=", k.downyHours, "warn"),
    r("downy_mildew", "downy_h", ">=", 2 * k.downyHours, "alarm"),
    r("powdery_mildew_warn", "pm_index", ">=", 40, "warn"),
    r("powdery_mildew", "pm_index", ">=", 60, "alarm"),
    r("water_stress_warn", "stress_day", ">=", k.stressDelta, "warn"),
    r("water_stress", "stress_day", ">=", 2 * k.stressDelta, "alarm"),
    r("leaf_heat", "leaf_c", ">=", k.leafHeat, "alarm"),
    r("ir_hotspot_warn", "hot_area", ">=", 3, "warn"),
    r("ir_hotspot", "hot_area", ">=", 10, "alarm"),
  ];
}
