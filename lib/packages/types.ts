// Shared shapes for the product side of a package: what the console shows (metrics, settings,
// presets, alert texts). The engine side (normalize, step, rules) is ModulePackage.
import type { RuleSpec } from "../engine/rules";

export type Locale = "en" | "it";
export type Status = "ok" | "warn" | "alarm" | "offline";
export type Text = Record<Locale, string>;

export interface MetricDef {
  key: string;
  label: Text;
  unit: string;
  decimals: number;
}

/** A setting the customer can change (thresholds, ...). Shown as a number field. */
export interface SettingDef {
  key: string;
  group: Text;
  label: Text;
  help?: Text;
  unit: string;
  step: number;
  /** stored value = shown value * scale (e.g. minutes shown, seconds stored) */
  scale?: number;
  min?: number;
  max?: number;
}

export interface Preset<Config = Record<string, number>> {
  id: string;
  name: Text;
  config: Partial<Config>;
}

/** Console description of a package. */
export interface PackageDef<Config = Record<string, number>> {
  id: string;
  name: string;
  tagline: Text;
  /** An object is offline after this many seconds without data. */
  offlineAfterS: number;
  /** Metrics shown to the customer (helper series used only by rules are left out). */
  metrics: MetricDef[];
  defaults: Config;
  settings: SettingDef[];
  presets?: Preset<Config>[];
  /** Error message key if a combination of settings makes no sense, else null. */
  validate?(config: Config): string | null;
  /** Customer settings as engine rules. */
  rules(config: Partial<Config>): RuleSpec[];
  /** Text for an open alert of rule `key` with its current value and threshold. */
  alertText(key: string, p: { value: number | null; limit: number | null }, locale: Locale): string;
}
