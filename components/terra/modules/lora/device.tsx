import Link from "next/link";
import { tenantDb } from "@/lib/engine/db";
import { series } from "@/lib/engine/query";
import type { ConsoleObject } from "@/lib/packages/console";
import { lora } from "@/lib/packages/lora/model";
import type { Locale } from "@/lib/packages/types";
import { timeAgo, type Dict } from "@/lib/i18n";
import { fmt, SectionTitle, StatusLabel } from "@/components/ui";
import { TimeChart } from "@/components/terra/chart";
import { ThermalMap, type ThermalFrame } from "./thermal-map";
import { LeafCalendar, type HourlyPoints } from "./leaf-calendar";

/** Progress towards a disease alert: 0..1 of the warning threshold, capped at 2 (alarm). */
function RiskBar({ label, value, warn, detail }: { label: string; value: number; warn: number; detail: string }) {
  const r = Math.min(2, value / warn);
  const color = r >= 2 ? "bg-alarm" : r >= 1 ? "bg-warn" : "bg-ok";
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-mist">{label}</span>
        <span className="num text-dim">{detail}</span>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-steel">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(2, r * 50)}%` }} />
      </div>
    </div>
  );
}

const CHART_KEYS = ["temp_c", "leaf_c", "dew_c", "rh", "vpd_kpa", "co2", "voc", "par", "uvi", "leaf_air", "ir_spread", "wet_h"];
const LEAF_DAYS = 14;

/** LoRa object page: live values, today's light, latest IR frame, history charts from the engine series. */
export async function LoraDevice({
  orgId,
  device,
  range,
  baseHref,
  t,
  locale,
}: {
  orgId: string;
  device: ConsoleObject;
  range: "24h" | "7d";
  baseHref: string;
  t: Dict;
  locale: Locale;
}) {
  const db = tenantDb(orgId);
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const [hist, light] = await Promise.all([
    series(db, { objectId: device.id, module: "lora", metrics: CHART_KEYS, from: new Date(now.getTime() - (range === "7d" ? 7 : 1) * 86400000), to: now }),
    series(db, { objectId: device.id, module: "lora", metrics: ["par"], from: midnight, to: now }),
  ]);
  // no IR frame (single-point sensor): leaf temperature hour by hour instead
  const ir = (device.properties.ir ?? null) as ThermalFrame | null;
  const leafHours = ir
    ? null
    : await series(db, { objectId: device.id, module: "lora", metrics: ["leaf_c", "dew_c"], from: new Date(now.getTime() - LEAF_DAYS * 86400000), to: now, level: "1h" });
  const pairs = (k: string): HourlyPoints => (leafHours?.series[k] ?? []).map((p) => [p.ts.getTime(), p.value]);

  // one chart row per timestamp with every metric that has a point there
  const byTs = new Map<number, Record<string, number>>();
  for (const [k, pts] of Object.entries(hist.series))
    for (const p of pts) {
      const ts = p.ts.getTime();
      const row = byTs.get(ts) ?? { t: ts };
      row[k] = p.value;
      byTs.set(ts, row);
    }
  const rows = [...byTs.values()].sort((a, b) => a.t - b.t);

  // Daily light integral: PAR (µmol/m²/s) integrated over today -> mol/m²/day
  let dli = 0;
  const par = light.series.par;
  for (let i = 1; i < par.length; i++) dli += (par[i - 1].value * (par[i].ts.getTime() - par[i - 1].ts.getTime())) / 1000 / 1e6;

  const status = device.status;
  const v = device.values;
  const pkgState = (device.state.pkg ?? {}) as Record<string, unknown>;
  const irrigating = typeof pkgState.irrigation_until === "number" && pkgState.irrigation_until > now.getTime();
  const cfg = { ...lora.defaults, ...((device.properties.config ?? {}) as object) };
  const L = (k: string) => lora.metrics.find((m) => m.key === k)!.label[locale];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs text-dim">LoRa{device.externalId && ` · #${device.externalId}`}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{device.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-mist">
            <StatusLabel status={status} t={t} />
            <span>
              {t.lastSeen}: {timeAgo(device.lastSeen, locale, t)}
            </span>
          </div>
          {irrigating && <p className="mt-2 text-sm text-ice">{t.irrigating}</p>}
        </div>
        <div className="flex shrink-0 gap-2 text-sm">
          {(["24h", "7d"] as const).map((r) => (
            <Link key={r} href={`${baseHref}?range=${r}`} className={`btn ${r === range ? "border-frost" : ""}`}>
              {t[`range_${r}`]}
            </Link>
          ))}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {lora.metrics.map((m) => (
          <div key={m.key} className="card p-4">
            <div className="text-[11px] text-dim">{m.label[locale]}</div>
            <div className="num mt-1 text-xl">
              {fmt(v[m.key], m.decimals, locale)}
              <span className="ml-1 text-xs text-dim">{m.unit}</span>
            </div>
          </div>
        ))}
        <div className="card p-4">
          <div className="text-[11px] text-dim">{t.dliToday}</div>
          <div className="num mt-1 text-xl">
            {fmt(dli, 1, locale)}
            <span className="ml-1 text-xs text-dim">mol/m²</span>
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-dim">{ir ? t.thermalMap : t.leafCalendar}</div>
          {ir ? (
            <ThermalMap
              frame={ir}
              air={v.temp_c ?? null}
              dew={v.dew_c ?? null}
              labels={{
              temp: t.ir_temp,
              dew: t.ir_dew,
              min: t.ir_min,
              max: t.ir_max,
              median: t.ir_median,
              wet: t.ir_wet,
              dry: t.ir_dry,
              hover: t.ir_fromDew,
              vsAir: t.ir_vsAir,
            }}
            />
          ) : (
            <LeafCalendar
              leaf={pairs("leaf_c")}
              dew={pairs("dew_c")}
              days={LEAF_DAYS}
              locale={locale}
              labels={{ temp: t.ir_temp, dew: t.ir_dew, wet: t.ir_wet, dry: t.ir_dry, empty: t.leafCalendarEmpty, fromDew: t.ir_fromDew }}
            />
          )}
        </div>
        <div className="card flex flex-col gap-5 p-4">
          <div className="text-[11px] uppercase tracking-[0.14em] text-dim">{t.diseaseRisk}</div>
          <RiskBar label={t.risk_botrytis} value={v.humid_h ?? 0} warn={cfg.botrytisHours} detail={`${fmt(v.humid_h ?? 0, 1, locale)} / ${cfg.botrytisHours} h`} />
          <RiskBar label={t.risk_downy} value={v.downy_h ?? 0} warn={cfg.downyHours} detail={`${fmt(v.downy_h ?? 0, 1, locale)} / ${cfg.downyHours} h`} />
          <RiskBar label={t.risk_powdery} value={v.pm_index ?? 0} warn={40} detail={`${fmt(v.pm_index, 0, locale)} / 100`} />
          <RiskBar
            label={t.risk_stress}
            value={Math.max(0, v.leaf_air ?? 0)}
            warn={cfg.stressDelta}
            detail={`${fmt(v.leaf_air, 1, locale)} / +${cfg.stressDelta} °C`}
          />
        </div>
      </div>

      <SectionTitle>{t.history}</SectionTitle>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <TimeChart
            rows={rows}
            locale={locale}
            unitLeft="°"
            series={[
              { key: "temp_c", label: L("temp_c"), color: "#ff8a5c" },
              { key: "leaf_c", label: L("leaf_c"), color: "#3ddc84" },
              { key: "dew_c", label: L("dew_c"), color: "#9fd8ff", dashed: true },
            ]}
          />
        </div>
        <div className="card p-4">
          <TimeChart
            rows={rows}
            locale={locale}
            unitLeft="%"
            unitRight=" kPa"
            series={[
              { key: "rh", label: L("rh"), color: "#9fd8ff" },
              { key: "vpd_kpa", label: L("vpd_kpa"), color: "#f2b84b", axis: "right" },
            ]}
          />
        </div>
        <div className="card p-4">
          <TimeChart
            rows={rows}
            locale={locale}
            series={[
              { key: "co2", label: `${L("co2")} (ppm)`, color: "#e9ebee" },
              { key: "voc", label: L("voc"), color: "#c792ea", axis: "right" },
            ]}
          />
        </div>
        <div className="card p-4">
          <TimeChart
            rows={rows}
            locale={locale}
            series={[
              { key: "par", label: `${L("par")} (µmol/m²/s)`, color: "#ffd166" },
              { key: "uvi", label: L("uvi"), color: "#b388ff", axis: "right" },
            ]}
          />
        </div>
        <div className="card p-4 lg:col-span-2">
          <TimeChart
            rows={rows}
            locale={locale}
            unitLeft="°"
            unitRight=" h"
            series={[
              { key: "leaf_air", label: L("leaf_air"), color: "#3ddc84" },
              { key: "ir_spread", label: L("ir_spread"), color: "#ff8a5c" },
              { key: "wet_h", label: L("wet_h"), color: "#9fd8ff", axis: "right" },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
