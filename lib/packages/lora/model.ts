import type { Locale, PackageDef, SettingDef } from "../types";
import type { RuleSpec } from "../../engine/rules";

export interface LoraConfig {
  tMin: number;
  tMax: number;
  tMargin: number;
  rhMin: number;
  rhMax: number;
  rhMargin: number;
  leafDewWarn: number;
  leafDewAlarm: number;
  co2LowWarn: number;
  irrigationJump: number;
  irrigationHoldS: number;
  botrytisHours: number;
  downyHours: number;
  stressDelta: number;
  leafHeat: number;
  hotspotDelta: number;
}

export const DEFAULTS: LoraConfig = {
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

export function dewPoint(t: number, rh: number): number {
  const a = 17.62,
    b = 243.12;
  const g = Math.log(Math.max(rh, 0.1) / 100) + (a * t) / (b + t);
  return (b * g) / (a - g);
}

export function vpd(t: number, rh: number, leaf: number | null): number {
  const es = (x: number) => 0.6108 * Math.exp((17.27 * x) / (x + 237.3));
  return es(leaf ?? t) - (es(t) * rh) / 100;
}

export const luxToPar = (lux: number) => lux / 54;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function irFrame(payload: Record<string, unknown>): { w: number; h: number; data: number[] } | null {
  const ir = payload.ir;
  if (!Array.isArray(ir) || !ir.length || !ir.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const w = num(payload.ir_w) ?? 16;
  const h = num(payload.ir_h) ?? Math.round(ir.length / w);
  return w * h === ir.length ? { w, h, data: ir as number[] } : null;
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
    key: "irrigationJump",
    group: OTHER,
    label: { en: "Irrigation humidity rise", it: "Aumento umidità da irrigazione" },
    help: { en: "Humidity rise that starts the alarm pause", it: "Aumento di umidità che avvia la pausa degli allarmi" },
    unit: "% RH",
    step: 1,
    min: 1,
    max: 50,
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

type P = { value: string; limit: string; near: boolean };
const TEXTS: Record<string, Record<Locale, (p: P) => string>> = {
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
    en: (p) => `Leaves ${p.value} °C from the dew point: condensation, disease risk (botrytis, mildew)`,
    it: (p) => `Foglie a ${p.value} °C dal punto di rugiada: condensa, rischio malattie (botrite, peronospora)`,
  },
  botrytis: {
    en: (p) => `Botrytis risk: ${p.value} h of humidity ≥ 90 % at mild temperature. Ventilate, heat lightly, avoid wetting the leaves`,
    it: (p) => `Rischio botrite: ${p.value} h di umidità ≥ 90 % a temperatura mite. Arieggiare, riscaldare leggermente, non bagnare le foglie`,
  },
  downy_mildew: {
    en: (p) => `Downy mildew risk: leaves wet for ${p.value} h at mild temperature. Dry the canopy, consider a preventive treatment`,
    it: (p) => `Rischio peronospora: foglie bagnate da ${p.value} h a temperatura mite. Asciugare la vegetazione, valutare un trattamento preventivo`,
  },
  powdery_mildew: {
    en: (p) => `Powdery mildew risk index ${p.value}/100: several warm days at 21-30 °C. Check the upper side of the leaves`,
    it: (p) => `Indice di rischio oidio ${p.value}/100: più giorni caldi a 21-30 °C. Controllare la pagina superiore delle foglie`,
  },
  water_stress: {
    en: (p) => `Water stress: leaves ${p.value} °C warmer than the air in daylight, stomata closing. Check irrigation`,
    it: (p) => `Stress idrico: foglie ${p.value} °C più calde dell'aria con la luce, stomi in chiusura. Controllare l'irrigazione`,
  },
  leaf_heat: {
    en: (p) => `Leaves at ${p.value} °C, above ${p.limit} °C: heat damage risk, shade or mist`,
    it: (p) => `Foglie a ${p.value} °C, sopra ${p.limit} °C: rischio scottature, ombreggiare o nebulizzare`,
  },
  ir_hotspot: {
    en: (p) => `Infrared camera: ${p.value} % of the canopy warmer than the rest. Possible local stress, dry spot or infection: inspect the plants`,
    it: (p) => `Termocamera: ${p.value} % della chioma più calda del resto. Possibile stress locale, zona secca o infezione: ispezionare le piante`,
  },
  co2_low: {
    en: (p) => `CO₂ at ${p.value} ppm: the crop is running out of CO₂, ventilate`,
    it: (p) => `CO₂ a ${p.value} ppm: le piante stanno esaurendo la CO₂, arieggiare`,
  },
};

export function rulesFromConfig(c: Partial<LoraConfig>): RuleSpec[] {
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

export const lora: PackageDef<LoraConfig> = {
  id: "lora",
  name: "LoRa",
  tagline: { en: "Greenhouse climate, leaf and air", it: "Clima della serra, foglia e aria" },
  offlineAfterS: 5 * 60,
  defaults: DEFAULTS,
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
  rules: rulesFromConfig,
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

  alertText(key, { value, limit }, locale) {
    const warn = key.endsWith("_warn");
    const t = TEXTS[warn ? key.slice(0, -5) : key]?.[locale];
    const d = (v: number | null) => (v === null ? "–" : String(Math.round(v * 10) / 10));
    return t ? t({ value: d(value), limit: d(limit), near: warn }) : key;
  },
};
