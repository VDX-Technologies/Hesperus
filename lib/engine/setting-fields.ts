import type { Locale } from "@/lib/packages/types";

type L = Record<Locale, string>;
type Unit = { label: string; factor: number };
export type Field = {
  key: string;
  label: L;
  units: Unit[];
  nullable?: L;
  step?: number;
};
export type Group = { id: string; title: L; fields: Field[] };

const MIN = [{ label: "min", factor: 1 }];
const H = [{ label: "h", factor: 1 }];
const DAYS = [{ label: "d", factor: 1 }];
const SEC = [{ label: "s", factor: 1 }];
const BYTES = [
  { label: "MB", factor: 1024 ** 2 },
  { label: "GB", factor: 1024 ** 3 },
  { label: "TB", factor: 1024 ** 4 },
];
const COUNT = [
  { label: "", factor: 1 },
  { label: "k", factor: 1e3 },
  { label: "M", factor: 1e6 },
];

export const GROUPS: Group[] = [
  {
    id: "quota",
    title: { en: "Quotas", it: "Quote" },
    fields: [
      { key: "quota.db_bytes", label: { en: "Database size", it: "Dimensione database" }, units: BYTES },
      { key: "quota.r2_bytes", label: { en: "Object storage size", it: "Spazio object storage" }, units: BYTES },
      { key: "quota.r2_writes_month", label: { en: "Storage writes per month", it: "Scritture storage al mese" }, units: COUNT },
      { key: "quota.r2_reads_month", label: { en: "Storage reads per month", it: "Letture storage al mese" }, units: COUNT },
      { key: "quota.alert_ratio", label: { en: "Alert at", it: "Avvisa al" }, units: [{ label: "%", factor: 0.01 }] },
    ],
  },
  {
    id: "retention",
    title: { en: "Data retention", it: "Conservazione dati" },
    fields: [
      { key: "retention.raw_days", label: { en: "Raw metrics", it: "Metriche grezze" }, units: DAYS },
      { key: "retention.rollup_5m_days", label: { en: "5 min averages", it: "Medie 5 min" }, units: DAYS },
      {
        key: "retention.rollup_1h_days",
        label: { en: "Hourly averages", it: "Medie orarie" },
        units: DAYS,
        nullable: { en: "forever", it: "per sempre" },
      },
      {
        key: "retention.audit_days",
        label: { en: "Activity history", it: "Storico attività" },
        units: DAYS,
        nullable: { en: "forever", it: "per sempre" },
      },
    ],
  },
  {
    id: "query",
    title: { en: "Charts", it: "Grafici" },
    fields: [
      { key: "query.raw_max_hours", label: { en: "Raw data up to", it: "Dati grezzi fino a" }, units: H },
      { key: "query.rollup_5m_max_days", label: { en: "5 min averages up to", it: "Medie 5 min fino a" }, units: DAYS },
    ],
  },
  {
    id: "jobs",
    title: { en: "Background jobs", it: "Processi in background" },
    fields: [
      { key: "rollup.interval_min", label: { en: "Compute averages every", it: "Calcola medie ogni" }, units: MIN },
      { key: "rollup.lookback_min", label: { en: "Recompute last", it: "Ricalcola ultimi" }, units: MIN },
      { key: "raw.flush_interval_min", label: { en: "Archive raw data every", it: "Archivia dati grezzi ogni" }, units: MIN },
      { key: "metrics.partitions_ahead_days", label: { en: "Partitions created ahead", it: "Partizioni create in anticipo" }, units: DAYS },
    ],
  },
  {
    id: "ingest",
    title: { en: "Ingest and health", it: "Ricezione e salute" },
    fields: [
      { key: "ingest.max_batch", label: { en: "Max messages per request", it: "Messaggi max per richiesta" }, units: COUNT },
      { key: "ingest.max_future_s", label: { en: "Reject readings ahead by", it: "Scarta letture nel futuro oltre" }, units: SEC },
      { key: "ingest.rate_per_min", label: { en: "Requests per minute per source", it: "Richieste al minuto per fonte" }, units: COUNT },
      { key: "ingest.burst", label: { en: "Burst of requests allowed", it: "Raffica di richieste consentita" }, units: COUNT },
      { key: "health.rate_limited_per_h", label: { en: "Rate-limited source alert after", it: "Avviso fonte limitata dopo" }, units: [{ label: "/h", factor: 1 }] },
      { key: "health.source_silent_min", label: { en: "Source silent alert after", it: "Avviso fonte muta dopo" }, units: MIN },
      { key: "raw.inbox_stale_min", label: { en: "Unarchived raw alert after", it: "Avviso dati non archiviati dopo" }, units: MIN },
    ],
  },
  {
    id: "upload",
    title: { en: "File uploads", it: "Caricamento file" },
    fields: [
      { key: "upload.max_bytes", label: { en: "Max file size", it: "Dimensione massima file" }, units: BYTES },
      { key: "upload.max_rows", label: { en: "Max rows per file", it: "Righe massime per file" }, units: COUNT },
      { key: "upload.files_per_day", label: { en: "Files per day per source", it: "File al giorno per fonte" }, units: COUNT },
    ],
  },
];

export const HIDDEN = new Set(["alerts.email_to", "alerts.email_from", "alerts.repeat_h"]);

export function display(f: Field, value: unknown): { amount: string; unit: number } {
  if (value === null || value === undefined) return { amount: "", unit: 0 };
  const v = Number(value);
  let unit = 0;
  f.units.forEach((u, i) => {
    if (v / u.factor >= 1) unit = i;
  });
  const amount = v / f.units[unit].factor;
  return { amount: String(Math.round(amount * 1000) / 1000), unit };
}

export function parse(f: Field, amount: string, unit: string): number | null | Error {
  const a = amount.trim().replace(",", ".");
  if (!a) return f.nullable ? null : new Error(f.key);
  const n = Number(a);
  if (!Number.isFinite(n) || n < 0) return new Error(f.key);
  const v = n * (f.units[Number(unit)] ?? f.units[0]).factor;
  return f.units[0].factor >= 1 ? Math.round(v) : Math.round(v * 1e6) / 1e6;
}
