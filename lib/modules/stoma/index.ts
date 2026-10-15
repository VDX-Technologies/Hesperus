/**
 * Stoma - greenhouse climate sensor (air, leaf, CO2, VOC, light, UV) with RGB status ring.
 * Payload: JSON forwarded by the LoRa gateway (firmware/gateway in serra-sensori):
 *   { node_id, seq, temp_c, rh, leaf_c, co2, voc, lux, uvi, flags, rssi, snr }
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
];

const TEXTS: Record<string, Record<Locale, (p: Record<string, number | string>) => string>> = {
  temp_high: {
    en: (p) => `Air temperature ${p.value} °C, above ${p.limit} °C`,
    it: (p) => `Temperatura dell'aria ${p.value} °C, sopra ${p.limit} °C`,
  },
  temp_low: {
    en: (p) => `Air temperature ${p.value} °C, below ${p.limit} °C`,
    it: (p) => `Temperatura dell'aria ${p.value} °C, sotto ${p.limit} °C`,
  },
  rh_high: {
    en: (p) => `Humidity ${p.value} %, above ${p.limit} %`,
    it: (p) => `Umidità ${p.value} %, sopra ${p.limit} %`,
  },
  rh_low: {
    en: (p) => `Humidity ${p.value} %, below ${p.limit} %`,
    it: (p) => `Umidità ${p.value} %, sotto ${p.limit} %`,
  },
  condensation: {
    en: (p) => `Leaves ${p.margin} °C from the dew point: condensation, disease risk (botrytis, mildew)`,
    it: (p) => `Foglie a ${p.margin} °C dal punto di rugiada: condensa, rischio malattie (botrite, peronospora)`,
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
  ],

  serialOf(payload) {
    const id = payload.node_id;
    return typeof id === "number" || typeof id === "string" ? String(id) : null;
  },

  ingest(payload, cfgIn, previous: PreviousReading | null, now): IngestResult {
    const cfg = { ...DEFAULTS, ...cfgIn };
    const t = num(payload.temp_c);
    const rh = num(payload.rh);
    const leaf = num(payload.leaf_c);
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

    const alerts: AlertSignal[] = [];
    const tBand = band(t, cfg.tMin, cfg.tMax, cfg.tMargin);
    if (t !== null && tBand > 0) {
      const high = t > (cfg.tMin + cfg.tMax) / 2;
      alerts.push({
        level: tBand === 2 ? "alarm" : "warn",
        code: high ? "temp_high" : "temp_low",
        params: { value: t.toFixed(1), limit: high ? cfg.tMax : cfg.tMin },
      });
    }
    if (!irrigating) {
      const rhBand = band(rh, cfg.rhMin, cfg.rhMax, cfg.rhMargin);
      if (rh !== null && rhBand > 0) {
        const high = rh > (cfg.rhMin + cfg.rhMax) / 2;
        alerts.push({
          level: rhBand === 2 ? "alarm" : "warn",
          code: high ? "rh_high" : "rh_low",
          params: { value: rh.toFixed(0), limit: high ? cfg.rhMax : cfg.rhMin },
        });
      }
      if (margin !== null && margin <= cfg.leafDewWarn)
        alerts.push({
          level: margin <= cfg.leafDewAlarm ? "alarm" : "warn",
          code: "condensation",
          params: { margin: margin.toFixed(1) },
        });
    }
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
      },
      meta: {
        seq: num(payload.seq),
        rssi: num(payload.rssi),
        snr: num(payload.snr),
        irrigating,
        irrigation_until: irrigationUntil ? new Date(irrigationUntil).toISOString() : null,
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
