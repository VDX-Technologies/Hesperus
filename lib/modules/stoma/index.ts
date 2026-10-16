/**
 * Stoma - greenhouse climate sensor (air, leaf, CO2, VOC, light, UV) with RGB status ring.
 * Payload: JSON forwarded by the LoRa gateway (firmware/gateway in serra-sensori):
 *   { node_id, seq, temp_c, rh, leaf_c, co2, voc, lux, uvi, flags, rssi, snr, ir?, ir_w?, ir_h? }
 * ir: optional thermal frame from the infrared array (row-major °C, ir_w x ir_h, e.g. 16x12
 * downsampled from an MLX90640 so it fits one LoRa packet once quantized by the node). When
 * present, leaf_c defaults to the canopy median and the frame is kept in meta.ir for the map.
 * Disease models (botrytis, downy and powdery mildew) need hours of history: their counters are
 * carried from one reading to the next in meta.
 * The rules mirror the on-device ring logic (firmware/sensor-node), so the colour in the
 * greenhouse and the colour in the app agree; here thresholds come from the customer config.
 */
import type { AlertSignal, IngestResult, Locale, ModuleDef, PreviousReading, SettingDef } from "../types";

export interface StomaConfig {
  tMin: number;
  tMax: number;
  tMargin: number;
  rhMin: number;
  rhMax: number;
  rhMargin: number;
  leafDewWarn: number; // °C above dew point
  leafDewAlarm: number;
  co2LowWarn: number; // ppm
  irrigationJump: number; // %RH rise between two readings
  irrigationHoldS: number;
  botrytisHours: number; // hours of RH >= 90 % at 10-25 °C
  downyHours: number; // hours of wet leaves at 10-25 °C
  stressDelta: number; // leaf above air by this much in daylight = water stress
  leafHeat: number; // °C
  hotspotDelta: number; // pixel above the canopy median by this much = hot spot
}

const DEFAULTS: StomaConfig = {
  tMin: 5,
  tMax: 32,
  tMargin: 2,
  rhMin: 40,
  rhMax: 90,
  rhMargin: 5,
  leafDewWarn: 2.5,
  leafDewAlarm: 1.0,
  co2LowWarn: 300,
  irrigationJump: 10,
  irrigationHoldS: 15 * 60,
  botrytisHours: 6,
  downyHours: 4,
  stressDelta: 2,
  leafHeat: 35,
  hotspotDelta: 3,
};

/** Dew point, Magnus formula, °C. */
export function dewPoint(t: number, rh: number): number {
  const a = 17.62,
    b = 243.12;
  const g = Math.log(Math.max(rh, 0.1) / 100) + (a * t) / (b + t);
  return (b * g) / (a - g);
}

/** Leaf-to-air vapour pressure deficit, kPa (air temperature if the leaf is unknown). */
export function vpd(t: number, rh: number, leaf: number | null): number {
  const es = (x: number) => 0.6108 * Math.exp((17.27 * x) / (x + 237.3));
  return es(leaf ?? t) - (es(t) * rh) / 100;
}

/** Sunlight approximation: PAR (µmol/m²/s) ≈ lux / 54. Good enough without a PAR sensor. */
export const luxToPar = (lux: number) => lux / 54;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/** Thermal frame from the payload, or null if missing or malformed. */
export function irFrame(payload: Record<string, unknown>): { w: number; h: number; data: number[] } | null {
  const ir = payload.ir;
  if (!Array.isArray(ir) || !ir.length || !ir.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const w = num(payload.ir_w) ?? 16;
  const h = num(payload.ir_h) ?? Math.round(ir.length / w);
  return w * h === ir.length ? { w, h, data: ir as number[] } : null;
}

const round = (v: number | null, d: number) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

function band(v: number | null, lo: number, hi: number, margin: number): 0 | 1 | 2 {
  if (v === null) return 0;
  if (v < lo || v > hi) return 2;
  if (v < lo + margin || v > hi - margin) return 1;
  return 0;
}

const AIR = { en: "Air temperature", it: "Temperatura dell'aria" };
const HUM = { en: "Humidity", it: "Umidità" };
const LEAF = { en: "Leaf condensation", it: "Condensa sulle foglie" };
const OTHER = { en: "CO₂ and irrigation", it: "CO₂ e irrigazione" };
const DISEASE = { en: "Diseases and leaf stress", it: "Malattie e stress fogliare" };
const SETTINGS: SettingDef[] = [
  { key: "tMin", group: AIR, label: { en: "Minimum", it: "Minima" }, unit: "°C", step: 0.5, min: -10, max: 50 },
  { key: "tMax", group: AIR, label: { en: "Maximum", it: "Massima" }, unit: "°C", step: 0.5, min: -10, max: 60 },
  {
    key: "tMargin",
    group: AIR,
    label: { en: "Early warning", it: "Preavviso" },
    help: { en: "Yellow when this close to a limit", it: "Giallo quando si è a questa distanza da un limite" },
    unit: "°C",
    step: 0.5,
    min: 0,
    max: 10,
  },
  { key: "rhMin", group: HUM, label: { en: "Minimum", it: "Minima" }, unit: "%", step: 1, min: 0, max: 100 },
  { key: "rhMax", group: HUM, label: { en: "Maximum", it: "Massima" }, unit: "%", step: 1, min: 0, max: 100 },
  { key: "rhMargin", group: HUM, label: { en: "Early warning", it: "Preavviso" }, unit: "%", step: 1, min: 0, max: 30 },
  {
    key: "leafDewWarn",
    group: LEAF,
    label: { en: "Attention below", it: "Attenzione sotto" },
    help: { en: "Leaf temperature above the dew point", it: "Temperatura della foglia sopra il punto di rugiada" },
    unit: "°C",
    step: 0.1,
    min: 0,
    max: 10,
  },
  { key: "leafDewAlarm", group: LEAF, label: { en: "Alarm below", it: "Allarme sotto" }, unit: "°C", step: 0.1, min: 0, max: 10 },
  { key: "co2LowWarn", group: OTHER, label: { en: "CO₂ low below", it: "CO₂ bassa sotto" }, unit: "ppm", step: 10, min: 0, max: 2000 },
  {
    key: "irrigationHoldS",
    group: OTHER,
    label: { en: "Pause humidity alarms after irrigation", it: "Pausa allarmi umidità dopo l'irrigazione" },
    unit: "min",
    step: 1,
    scale: 60,
    min: 0,
    max: 120,
  },
  {
    key: "botrytisHours",
    group: DISEASE,
    label: { en: "Botrytis after", it: "Botrite dopo" },
    help: { en: "Hours of humidity ≥ 90 % at 10-25 °C", it: "Ore di umidità ≥ 90 % a 10-25 °C" },
    unit: "h",
    step: 0.5,
    min: 1,
    max: 48,
  },
  {
    key: "downyHours",
    group: DISEASE,
    label: { en: "Downy mildew after", it: "Peronospora dopo" },
    help: { en: "Hours of wet leaves at 10-25 °C", it: "Ore di foglia bagnata a 10-25 °C" },
    unit: "h",
    step: 0.5,
    min: 1,
    max: 48,
  },
  {
    key: "stressDelta",
    group: DISEASE,
    label: { en: "Water stress: leaf above air by", it: "Stress idrico: foglia sopra l'aria di" },
    help: { en: "In daylight a transpiring leaf is cooler than the air", it: "Di giorno una foglia che traspira è più fresca dell'aria" },
    unit: "°C",
    step: 0.5,
    min: 0.5,
    max: 10,
  },
  { key: "leafHeat", group: DISEASE, label: { en: "Leaf too hot above", it: "Foglia troppo calda sopra" }, unit: "°C", step: 0.5, min: 20, max: 50 },
  {
    key: "hotspotDelta",
    group: DISEASE,
    label: { en: "Infrared hot spot above median by", it: "Punto caldo infrarosso sopra la mediana di" },
    unit: "°C",
    step: 0.5,
    min: 1,
    max: 15,
  },
];

const TEXTS: Record<string, Record<Locale, (p: Record<string, number | string>) => string>> = {
  // near = 1: still inside the limits but within the early-warning margin
  temp_high: {
    en: (p) => `Air temperature ${p.value} °C, ${p.near ? "close to the maximum of" : "above"} ${p.limit} °C`,
    it: (p) => `Temperatura dell'aria ${p.value} °C, ${p.near ? "vicina alla massima di" : "sopra"} ${p.limit} °C`,
  },
  temp_low: {
    en: (p) => `Air temperature ${p.value} °C, ${p.near ? "close to the minimum of" : "below"} ${p.limit} °C`,
    it: (p) => `Temperatura dell'aria ${p.value} °C, ${p.near ? "vicina alla minima di" : "sotto"} ${p.limit} °C`,
  },
  rh_high: {
    en: (p) => `Humidity ${p.value} %, ${p.near ? "close to the maximum of" : "above"} ${p.limit} %`,
    it: (p) => `Umidità ${p.value} %, ${p.near ? "vicina alla massima di" : "sopra"} ${p.limit} %`,
  },
  rh_low: {
    en: (p) => `Humidity ${p.value} %, ${p.near ? "close to the minimum of" : "below"} ${p.limit} %`,
    it: (p) => `Umidità ${p.value} %, ${p.near ? "vicina alla minima di" : "sotto"} ${p.limit} %`,
  },
  condensation: {
    en: (p) => `Leaves ${p.margin} °C from the dew point${p.area ? ` (${p.area} % of the canopy wet)` : ""}: condensation, disease risk (botrytis, mildew)`,
    it: (p) => `Foglie a ${p.margin} °C dal punto di rugiada${p.area ? ` (${p.area} % della chioma bagnata)` : ""}: condensa, rischio malattie (botrite, peronospora)`,
  },
  botrytis: {
    en: (p) => `Botrytis risk: ${p.hours} h of humidity ≥ 90 % at mild temperature. Ventilate, heat lightly, avoid wetting the leaves`,
    it: (p) => `Rischio botrite: ${p.hours} h di umidità ≥ 90 % a temperatura mite. Arieggiare, riscaldare leggermente, non bagnare le foglie`,
  },
  downy_mildew: {
    en: (p) => `Downy mildew risk: leaves wet for ${p.hours} h at ${p.temp} °C. Dry the canopy, consider a preventive treatment`,
    it: (p) => `Rischio peronospora: foglie bagnate da ${p.hours} h a ${p.temp} °C. Asciugare la vegetazione, valutare un trattamento preventivo`,
  },
  powdery_mildew: {
    en: (p) => `Powdery mildew risk index ${p.index}/100: several warm days at 21-30 °C. Check the upper side of the leaves`,
    it: (p) => `Indice di rischio oidio ${p.index}/100: più giorni caldi a 21-30 °C. Controllare la pagina superiore delle foglie`,
  },
  water_stress: {
    en: (p) => `Water stress: leaves ${p.delta} °C warmer than the air in daylight, stomata closing. Check irrigation`,
    it: (p) => `Stress idrico: foglie ${p.delta} °C più calde dell'aria con la luce, stomi in chiusura. Controllare l'irrigazione`,
  },
  leaf_heat: {
    en: (p) => `Leaves at ${p.value} °C, above ${p.limit} °C: heat damage risk, shade or mist`,
    it: (p) => `Foglie a ${p.value} °C, sopra ${p.limit} °C: rischio scottature, ombreggiare o nebulizzare`,
  },
  ir_hotspot: {
    en: (p) => `Infrared camera: ${p.area} % of the canopy at least ${p.delta} °C warmer than the rest (up to ${p.max} °C). Possible local stress, dry spot or infection: inspect the plants`,
    it: (p) => `Termocamera: ${p.area} % della chioma almeno ${p.delta} °C più calda del resto (fino a ${p.max} °C). Possibile stress locale, zona secca o infezione: ispezionare le piante`,
  },
  co2_low: {
    en: (p) => `CO₂ at ${p.value} ppm: the crop is running out of CO₂, ventilate`,
    it: (p) => `CO₂ a ${p.value} ppm: le piante stanno esaurendo la CO₂, arieggiare`,
  },
};

export const stoma: ModuleDef<StomaConfig> = {
  id: "stoma",
  name: "Stoma",
  tagline: { en: "Greenhouse climate, leaf and air", it: "Clima della serra, foglia e aria" },
  offlineAfterS: 5 * 60,
  defaultConfig: DEFAULTS,
  settings: SETTINGS,
  presets: [
    { id: "tomato", name: { en: "Tomato", it: "Pomodoro" }, config: { tMin: 12, tMax: 30, rhMin: 55, rhMax: 85, botrytisHours: 6, downyHours: 4, stressDelta: 2, leafHeat: 35 } },
    { id: "strawberry", name: { en: "Strawberry", it: "Fragola" }, config: { tMin: 8, tMax: 26, rhMin: 60, rhMax: 85, botrytisHours: 4, downyHours: 4, stressDelta: 2, leafHeat: 32 } },
    { id: "basil", name: { en: "Basil", it: "Basilico" }, config: { tMin: 15, tMax: 30, rhMin: 50, rhMax: 80, botrytisHours: 6, downyHours: 3, stressDelta: 2.5, leafHeat: 34 } },
    { id: "lettuce", name: { en: "Lettuce", it: "Lattuga" }, config: { tMin: 6, tMax: 24, rhMin: 60, rhMax: 85, botrytisHours: 5, downyHours: 3, stressDelta: 1.5, leafHeat: 30 } },
    { id: "ornamental", name: { en: "Ornamentals", it: "Ornamentali" }, config: { tMin: 10, tMax: 28, rhMin: 50, rhMax: 85, botrytisHours: 6, downyHours: 4, stressDelta: 2, leafHeat: 34 } },
  ],
  validate: (c) => {
    const cfg = { ...DEFAULTS, ...c };
    if (cfg.tMin >= cfg.tMax) return "badTempRange";
    if (cfg.rhMin >= cfg.rhMax) return "badRhRange";
    if (cfg.leafDewAlarm > cfg.leafDewWarn) return "badLeafRange";
    return null;
  },
  deviceConfig: (c) => {
    const cfg = { ...DEFAULTS, ...c };
    return {
      tMin: cfg.tMin,
      tMax: cfg.tMax,
      tMargin: cfg.tMargin,
      rhMin: cfg.rhMin,
      rhMax: cfg.rhMax,
      rhMargin: cfg.rhMargin,
      leafDewWarn: cfg.leafDewWarn,
      leafDewAlarm: cfg.leafDewAlarm,
      co2LowWarn: cfg.co2LowWarn,
      irrigationHoldS: cfg.irrigationHoldS,
    };
  },
  metrics: [
    { key: "temp_c", label: { en: "Air", it: "Aria" }, unit: "°C", decimals: 1 },
    { key: "rh", label: { en: "Humidity", it: "Umidità" }, unit: "%", decimals: 0 },
    { key: "leaf_c", label: { en: "Leaf", it: "Foglia" }, unit: "°C", decimals: 1 },
    { key: "dew_c", label: { en: "Dew point", it: "Punto di rugiada" }, unit: "°C", decimals: 1 },
    { key: "cond_margin", label: { en: "Condensation margin", it: "Margine condensa" }, unit: "°C", decimals: 1 },
    { key: "vpd_kpa", label: { en: "VPD", it: "VPD" }, unit: "kPa", decimals: 2 },
    { key: "co2", label: { en: "CO₂", it: "CO₂" }, unit: "ppm", decimals: 0 },
    { key: "voc", label: { en: "VOC index", it: "Indice VOC" }, unit: "", decimals: 0 },
    { key: "lux", label: { en: "Light", it: "Luce" }, unit: "lx", decimals: 0 },
    { key: "par", label: { en: "PAR (est.)", it: "PAR (stima)" }, unit: "µmol/m²/s", decimals: 0 },
    { key: "uvi", label: { en: "UV index", it: "Indice UV" }, unit: "", decimals: 1 },
    { key: "leaf_air", label: { en: "Leaf − air", it: "Foglia − aria" }, unit: "°C", decimals: 1 },
    { key: "ir_spread", label: { en: "Canopy spread (IR)", it: "Disomogeneità chioma (IR)" }, unit: "°C", decimals: 1 },
    { key: "wet_h", label: { en: "Leaf wetness", it: "Bagnatura fogliare" }, unit: "h", decimals: 1 },
    { key: "pm_index", label: { en: "Powdery mildew index", it: "Indice oidio" }, unit: "/100", decimals: 0 },
  ],

  serialOf(payload) {
    const id = payload.node_id;
    return typeof id === "number" || typeof id === "string" ? String(id) : null;
  },

  ingest(payload, cfgIn, previous: PreviousReading | null, now): IngestResult {
    const cfg = { ...DEFAULTS, ...cfgIn };
    const t = num(payload.temp_c);
    const rh = num(payload.rh);
    const frame = irFrame(payload);
    const leaf = num(payload.leaf_c) ?? (frame ? median(frame.data) : null);
    const co2 = num(payload.co2);
    const lux = num(payload.lux);
    const dew = t !== null && rh !== null ? dewPoint(t, rh) : null;
    const margin = leaf !== null && dew !== null ? leaf - dew : null;

    // Irrigation boom: a sudden humidity jump suspends humidity/condensation alarms for a while.
    const prevRh = num(previous?.values.rh);
    const prevUntil = typeof previous?.meta.irrigation_until === "string" ? Date.parse(previous.meta.irrigation_until) : 0;
    let irrigationUntil = prevUntil > now.getTime() ? prevUntil : 0;
    if (rh !== null && prevRh !== null && rh - prevRh >= cfg.irrigationJump)
      irrigationUntil = now.getTime() + cfg.irrigationHoldS * 1000;
    const irrigating = irrigationUntil > now.getTime();

    // Disease counters: hours accumulated since the previous reading (capped, so a gap in the
    // data does not count as hours of risk).
    const pm = (k: string) => num(previous?.meta[k]) ?? 0;
    const dtH = previous ? Math.min(1, Math.max(0, (now.getTime() - Date.parse(previous.ts)) / 3600000)) : 0;
    const wet = (margin !== null && margin <= cfg.leafDewAlarm) || (rh !== null && rh >= 97);
    const wetH = wet ? pm("wet_h") + dtH : 0;
    const humidH = rh !== null && rh >= 90 && t !== null && t >= 10 && t <= 25 ? pm("humid_h") + dtH : 0;
    // Powdery mildew, simplified Gubler-Thomas: a day with >= 6 h at 21-30 °C adds 20, else -10.
    const day = now.toISOString().slice(0, 10);
    const prevDay = typeof previous?.meta.pm_day === "string" ? previous.meta.pm_day : day;
    let pmIndex = pm("pm_base");
    let pmHours = pm("pm_hours");
    if (prevDay !== day) {
      pmIndex = Math.min(100, Math.max(0, pmIndex + (pmHours >= 6 ? 20 : -10)));
      pmHours = 0;
    }
    if (t !== null && t >= 21 && t <= 30) pmHours += dtH;
    const pmNow = Math.min(100, pmIndex + (pmHours >= 6 ? 20 : 0));

    // Infrared frame: canopy spread, wet area and hot spots
    let irSpread: number | null = null,
      wetArea = 0,
      hotArea = 0,
      irMax: number | null = null;
    if (frame) {
      const med = median(frame.data)!;
      irSpread = pct(frame.data, 95) - pct(frame.data, 5);
      irMax = Math.max(...frame.data);
      if (dew !== null) wetArea = frame.data.filter((x) => x - dew <= cfg.leafDewAlarm).length / frame.data.length;
      hotArea = frame.data.filter((x) => x - med >= cfg.hotspotDelta).length / frame.data.length;
    }
    const daylight = lux !== null && lux > 10000;
    const leafAir = leaf !== null && t !== null ? leaf - t : null;

    const alerts: AlertSignal[] = [];
    const tBand = band(t, cfg.tMin, cfg.tMax, cfg.tMargin);
    if (t !== null && tBand > 0) {
      const high = t > (cfg.tMin + cfg.tMax) / 2;
      alerts.push({
        level: tBand === 2 ? "alarm" : "warn",
        code: high ? "temp_high" : "temp_low",
        params: { value: t.toFixed(1), limit: high ? cfg.tMax : cfg.tMin, near: tBand === 1 ? 1 : 0 },
      });
    }
    if (!irrigating) {
      const rhBand = band(rh, cfg.rhMin, cfg.rhMax, cfg.rhMargin);
      if (rh !== null && rhBand > 0) {
        const high = rh > (cfg.rhMin + cfg.rhMax) / 2;
        alerts.push({
          level: rhBand === 2 ? "alarm" : "warn",
          code: high ? "rh_high" : "rh_low",
          params: { value: rh.toFixed(0), limit: high ? cfg.rhMax : cfg.rhMin, near: rhBand === 1 ? 1 : 0 },
        });
      }
      if (margin !== null && margin <= cfg.leafDewWarn)
        alerts.push({
          level: margin <= cfg.leafDewAlarm ? "alarm" : "warn",
          code: "condensation",
          params: { margin: margin.toFixed(1), area: wetArea ? Math.round(wetArea * 100) : 0 },
        });
    }
    if (humidH >= cfg.botrytisHours)
      alerts.push({ level: humidH >= 2 * cfg.botrytisHours ? "alarm" : "warn", code: "botrytis", params: { hours: humidH.toFixed(1) } });
    if (wetH >= cfg.downyHours && t !== null && t >= 10 && t <= 25)
      alerts.push({
        level: wetH >= 2 * cfg.downyHours ? "alarm" : "warn",
        code: "downy_mildew",
        params: { hours: wetH.toFixed(1), temp: t.toFixed(0) },
      });
    if (pmNow >= 40) alerts.push({ level: pmNow >= 60 ? "alarm" : "warn", code: "powdery_mildew", params: { index: pmNow } });
    if (daylight && leafAir !== null && leafAir >= cfg.stressDelta)
      alerts.push({ level: leafAir >= 2 * cfg.stressDelta ? "alarm" : "warn", code: "water_stress", params: { delta: leafAir.toFixed(1) } });
    if (leaf !== null && leaf >= cfg.leafHeat)
      alerts.push({ level: "alarm", code: "leaf_heat", params: { value: leaf.toFixed(1), limit: cfg.leafHeat } });
    if (hotArea >= 0.03)
      alerts.push({
        level: hotArea >= 0.1 ? "alarm" : "warn",
        code: "ir_hotspot",
        params: { area: Math.round(hotArea * 100), delta: cfg.hotspotDelta, max: irMax!.toFixed(1) },
      });
    if (co2 !== null && co2 < cfg.co2LowWarn) alerts.push({ level: "warn", code: "co2_low", params: { value: co2 } });

    const status = alerts.some((a) => a.level === "alarm") ? "alarm" : alerts.length ? "warn" : "ok";
    return {
      values: {
        temp_c: round(t, 2),
        rh: round(rh, 1),
        leaf_c: round(leaf, 2),
        dew_c: round(dew, 2),
        cond_margin: round(margin, 2),
        vpd_kpa: t !== null && rh !== null ? round(vpd(t, rh, leaf), 3) : null,
        co2: round(co2, 0),
        voc: round(num(payload.voc), 0),
        lux: round(lux, 0),
        par: lux !== null ? round(luxToPar(lux), 0) : null,
        uvi: round(num(payload.uvi), 2),
        leaf_air: round(leafAir, 2),
        ir_spread: round(irSpread, 2),
        wet_h: round(wetH, 2),
        pm_index: round(pmNow, 0),
      },
      meta: {
        seq: num(payload.seq),
        rssi: num(payload.rssi),
        snr: num(payload.snr),
        irrigating,
        irrigation_until: irrigationUntil ? new Date(irrigationUntil).toISOString() : null,
        wet_h: wetH,
        humid_h: humidH,
        pm_day: day,
        pm_base: pmIndex,
        pm_hours: pmHours,
        ir: frame ? { w: frame.w, h: frame.h, data: frame.data.map((x) => Math.round(x * 10) / 10) } : null,
      },
      status,
      alerts,
    };
  },

  alertText(code, params, locale) {
    const t = TEXTS[code]?.[locale];
    return t ? t(params) : code;
  },
};
