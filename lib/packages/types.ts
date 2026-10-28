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

export interface SettingDef {
  key: string;
  group: Text;
  label: Text;
  help?: Text;
  unit: string;
  step: number;
  scale?: number;
  min?: number;
  max?: number;
}

export interface Preset<Config = Record<string, number>> {
  id: string;
  name: Text;
  config: Partial<Config>;
}

export interface PackageDef<Config = Record<string, number>> {
  id: string;
  name: string;
  tagline: Text;
  offlineAfterS: number;
  metrics: MetricDef[];
  defaults: Config;
  settings: SettingDef[];
  presets?: Preset<Config>[];
  validate?(config: Config): string | null;
  rules(config: Partial<Config>): RuleSpec[];
  alertText(key: string, p: { value: number | null; limit: number | null }, locale: Locale): string;
}
