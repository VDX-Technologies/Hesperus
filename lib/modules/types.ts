/**
 * VDX Core module contract.
 *
 * A module is one VDX product (Stoma, Tag, Kestrel, ...). It owns everything specific to that
 * product: how raw gateway payloads become readings, which metrics exist, the status/alert
 * rules and the alert texts. The platform (database, ingest API, console, dashboard shell)
 * stays product-agnostic and only talks to modules through this interface.
 * UI pieces of a module live in components/modules/<id>/ and are registered in
 * components/modules/registry.tsx.
 */
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

export interface AlertSignal {
  level: "warn" | "alarm";
  code: string; // unique inside the module, stored as "<module>.<code>"
  params?: Record<string, number | string>;
}

export interface PreviousReading {
  ts: string;
  values: Record<string, number | null>;
  meta: Record<string, unknown>;
}

export interface IngestResult {
  values: Record<string, number | null>;
  meta: Record<string, unknown>;
  status: Exclude<Status, "offline">;
  alerts: AlertSignal[]; // conditions active right now (the platform opens/closes alert rows)
}

export interface ModuleDef<Config = Record<string, unknown>> {
  id: string;
  name: string;
  tagline: Text;
  /** Device is considered offline after this many seconds without data. */
  offlineAfterS: number;
  metrics: MetricDef[];
  defaultConfig: Config;
  settings: SettingDef[];
  /** Typical settings for common crops, offered as one-click starting points in the settings form. */
  presets?: { id: string; name: Text; config: Partial<Config> }[];
  /** Error message key if a combination of settings makes no sense, else null. */
  validate?(config: Config): string | null;
  /** Settings to push down to the device (e.g. so the status ring uses the same thresholds). */
  deviceConfig?(config: Config): Record<string, number>;
  /** Device serial from a raw gateway payload, or null if the payload is not for this module. */
  serialOf(payload: Record<string, unknown>): string | null;
  ingest(payload: Record<string, unknown>, config: Config, previous: PreviousReading | null, now: Date): IngestResult;
  alertText(code: string, params: Record<string, number | string>, locale: Locale): string;
}
