import Link from "next/link";
import { tenantDb } from "@/lib/engine/db";
import { listObjects, type ConsoleObject } from "@/lib/packages/console";
import { multiObjectSeries } from "@/lib/engine/query";
import { effectiveRules, loadRules } from "@/lib/engine/rules";
import { stoma } from "@/lib/packages/stoma/model";
import type { Locale } from "@/lib/packages/types";
import { timeAgo, type Dict } from "@/lib/i18n";
import { fmt, SectionTitle, StatusDot } from "@/components/ui";
import { SensorMetricGrid, type SensorMetricPanel } from "@/components/chart";

type Values = Record<string, number | null>;

const KEY_METRICS = ["temp_c", "rh", "leaf_c", "cond_margin", "vpd_kpa", "co2"];
const HISTORY_METRICS = ["temp_c", "rh", "vpd_kpa", "co2"];
const HISTORY_BUCKET_MS = 5 * 60_000;
const SENSOR_PALETTE = ["#9fd8ff", "#70d6b3", "#c7a6ff", "#f2b84b", "#ff8e8e", "#67c6d0", "#d9df75", "#f49ac2"];

/** Stoma widget on the organization overview: one card per sensor, grouped by place. */
export async function StomaOverview({ orgId, slug, t, locale, cards: providedCards }: {
  orgId: string; slug: string; t: Dict; locale: Locale; period?: number; cards?: ConsoleObject[];
}) {
  const db = tenantDb(orgId);
  const cards = providedCards ?? await listObjects(db, "stoma");
  const priority = { alarm: 0, warn: 1, offline: 2, ok: 3 } as const;
  const chartCards = [...cards].sort((a, b) => priority[a.status] - priority[b.status]
    || (a.lastSeen ?? "").localeCompare(b.lastSeen ?? "") || a.name.localeCompare(b.name)).slice(0, 8);
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60_000);
  const [history, rules] = chartCards.length ? await Promise.all([
    multiObjectSeries(db, { objectIds: chartCards.map((d) => d.id), module: "stoma", metrics: HISTORY_METRICS, from, to: now }),
    loadRules(db, "stoma"),
  ]) : [[], []];
  const firstBucket = Math.floor(from.getTime() / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
  const lastBucket = Math.floor(now.getTime() / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
  const chartRows = new Map(HISTORY_METRICS.map((metric) => [metric, Array.from({ length: Math.floor((lastBucket - firstBucket) / HISTORY_BUCKET_MS) + 1 }, (_, i) => {
    const row: Record<string, number | null> = { t: firstBucket + i * HISTORY_BUCKET_MS };
    for (const sensor of chartCards) {
      row[sensor.id] = null;
      row[`${sensor.id}__min`] = null;
      row[`${sensor.id}__max`] = null;
    }
    return row;
  })] as const));
  for (const point of history) {
    const index = Math.floor((point.ts.getTime() - firstBucket) / HISTORY_BUCKET_MS);
    const rows = chartRows.get(point.key);
    if (!rows || index < 0 || index >= rows.length) continue;
    rows[index][point.objectId] = point.value;
    rows[index][`${point.objectId}__min`] = point.min;
    rows[index][`${point.objectId}__max`] = point.max;
  }
  const sensorSeries = chartCards.map((d, i) => ({ key: d.id, label: d.name, color: SENSOR_PALETTE[i % SENSOR_PALETTE.length] }));
  const effective = new Map(chartCards.map((d) => [d.id, effectiveRules(rules, d.type, d.id)]));
  const metricInfo = new Map(stoma.metrics.map((m) => [m.key, m]));
  const sensorPanels: SensorMetricPanel[] = HISTORY_METRICS.map((key) => {
    const ruleMetric = key === "rh" ? "rh_ctl" : key;
    const perSensor = chartCards.map((d) => (effective.get(d.id) ?? [])
      .filter((r) => r.metric === ruleMetric && r.severity !== "info")
      .map((r) => ({ value: r.threshold, op: r.op, severity: r.severity, label: r.severity === "alarm" ? t.chart_alarm : t.chart_warning }))
      .sort((a, b) => a.value - b.value || a.op.localeCompare(b.op)));
    const signatures = new Set(perSensor.map((items) => JSON.stringify(items.map(({ value, op, severity }) => [value, op, severity]))));
    const thresholdsDiffer = signatures.size > 1 && perSensor.some((items) => items.length > 0);
    const thresholds = thresholdsDiffer ? [] : perSensor[0] ?? [];
    const info = metricInfo.get(key)!;
    return {
      key,
      label: info.label[locale],
      unit: info.unit,
      rows: chartRows.get(key) ?? [],
      series: sensorSeries,
      thresholds,
      thresholdNote: thresholdsDiffer ? t.chart_thresholdsDiffer : undefined,
      note: key === "rh" && thresholds.length ? t.chart_rhPause : undefined,
    };
  });
  const metrics = new Map(stoma.metrics.map((m) => [m.key, m]));
  const counts = { ok: 0, warn: 0, alarm: 0, offline: 0 };
  for (const d of cards) counts[d.status]++;
  // one group per place, in path order; objects without a place come last
  const groups = new Map<string, ConsoleObject[]>();
  for (const d of [...cards].sort((a, b) => a.placePath.join("\u0000").localeCompare(b.placePath.join("\u0000"))))
    groups.set(d.placePath.join(" · "), [...(groups.get(d.placePath.join(" · ")) ?? []), d]);
  const unassigned = groups.get("");
  groups.delete("");
  if (unassigned) groups.set("", unassigned);
  return (
    <section id="module-stoma">
      <SectionTitle
        right={
          <div className="flex gap-4 text-xs text-mist">
            {(["ok", "warn", "alarm", "offline"] as const).map((s) =>
              counts[s] ? (
                <span key={s} className="inline-flex items-center gap-1.5">
                  <StatusDot status={s} /> <span className="num">{counts[s]}</span> {t[`status_${s}`]}
                </span>
              ) : null,
            )}
          </div>
        }
      >
        Stoma · {stoma.tagline[locale]}
      </SectionTitle>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-dim">{t.chart_sensorHistory}</span>
          <span className="text-[10px] text-dim">
            {chartCards.length} {t.devices.toLowerCase()} · {t.chart_last24h} · {t.chart_fiveMinute}
            {chartCards.length < cards.length ? ` · ${cards.length - chartCards.length} ${t.chart_moreSensors}` : ""}
          </span>
        </div>
        <SensorMetricGrid panels={sensorPanels} locale={locale} minMaxLabel={t.chart_minMax} emptyLabel={t.chart_noHistory} />
      </div>
      {[...groups].map(([place, list]) => (
        <div key={place} className="mb-6">
          {groups.size > 1 && <div className="mb-2 text-xs uppercase tracking-[0.14em] text-dim">{place || t.unassigned}</div>}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((d) => {
              const v: Values = d.values;
              return (
                <Link key={d.id} href={`/o/${slug}/devices/${d.id}`} className="card group block p-5 transition-colors hover:border-line">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-medium">{d.name}</div>
                    </div>
                    <span className="inline-flex items-center gap-2 text-xs text-mist">
                      <StatusDot status={d.status} pulse />
                      {t[`status_${d.status}`]}
                    </span>
                  </div>
                  <div className="mt-5 grid grid-cols-3 gap-x-4 gap-y-3">
                    {KEY_METRICS.map((k) => {
                      const m = metrics.get(k)!;
                      return (
                        <div key={k}>
                          <div className="text-[11px] text-dim">{m.label[locale]}</div>
                          <div className="num text-lg">
                            {fmt(v[k], m.decimals, locale)}
                            <span className="ml-0.5 text-xs text-dim">{m.unit}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-4 text-xs text-dim">
                    {t.lastSeen}: {timeAgo(d.lastSeen, locale, t)}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
