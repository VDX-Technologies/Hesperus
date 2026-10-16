import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { stoma } from "@/lib/modules/stoma";
import type { Locale } from "@/lib/modules/types";
import { timeAgo, type Dict } from "@/lib/i18n";
import { fmt, liveStatus, SectionTitle, StatusLabel } from "@/components/ui";
import { TimeChart } from "@/components/chart";
import type { ThermalFrame } from "./thermal-map";
import { ThermalPlayer, type ThermalShot } from "./thermal-player";

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

type Values = Record<string, number | null>;
interface Device {
  id: string;
  name: string;
  serial: string;
  last_seen: string | null;
  last_status: string | null;
  last_values: Values | null;
}

const MAX_POINTS = 400;

/** Start of the chart range and of today (for the daily light integral). */
function bounds(range: "24h" | "7d") {
  const since = new Date(Date.now() - (range === "7d" ? 7 : 1) * 86400000);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return { since, midnight, from: since < midnight ? since : midnight };
}

/** Stoma device page: live values, today's light, history charts. */
export async function StomaDevice({
  supabase,
  device,
  range,
  baseHref,
  t,
  locale,
}: {
  supabase: SupabaseClient;
  device: Device & { config?: unknown };
  range: "24h" | "7d";
  baseHref: string;
  t: Dict;
  locale: Locale;
}) {
  const { since, midnight, from } = bounds(range);
  const { data } = await supabase
    .from("readings")
    .select("ts, values, meta")
    .eq("device_id", device.id)
    .gte("ts", from.toISOString())
    .order("ts")
    .limit(5000);
  const all = (data ?? []).map((r) => ({ t: Date.parse(r.ts), v: r.values as Values, meta: r.meta as Record<string, unknown> }));

  // Daily light integral: PAR (µmol/m²/s) integrated over today -> mol/m²/day
  let dli = 0;
  const today = all.filter((r) => r.t >= midnight.getTime());
  for (let i = 1; i < today.length; i++) {
    const par = today[i - 1].v.par ?? 0;
    dli += (par * (today[i].t - today[i - 1].t)) / 1000 / 1e6;
  }

  const inRange = all.filter((r) => r.t >= since.getTime());
  const step = Math.max(1, Math.ceil(inRange.length / MAX_POINTS));
  const rows = inRange.filter((_, i) => i % step === 0).map((r) => ({ t: r.t, ...r.v }));
  const status = liveStatus(device.last_status, device.last_seen, stoma.offlineAfterS);
  const v = device.last_values ?? {};
  const lastMeta = all.at(-1)?.meta ?? {};
  const ir = (lastMeta.ir ?? null) as ThermalFrame | null;
  // one frame per hour over the last 24 h for the time-lapse, plus the latest
  const irHistory: ThermalShot[] = [];
  let nextHour = 0;
  for (const r of all.filter((r) => r.t >= Date.now() - 86400000 && r.meta.ir)) {
    if (r.t < nextHour && r !== all.at(-1)) continue;
    irHistory.push({ t: r.t, frame: r.meta.ir as ThermalFrame, air: r.v.temp_c ?? null, dew: r.v.dew_c ?? null });
    nextHour = r.t + 3600000;
  }
  if (ir && irHistory.at(-1)?.frame !== ir) irHistory.push({ t: all.at(-1)!.t, frame: ir, air: v.temp_c ?? null, dew: v.dew_c ?? null });
  const cfg = { ...stoma.defaultConfig, ...((device.config ?? {}) as object) };
  const num = (x: unknown) => (typeof x === "number" ? x : 0);
  const L = (k: string) => stoma.metrics.find((m) => m.key === k)!.label[locale];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs text-dim">Stoma · #{device.serial}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{device.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-mist">
            <StatusLabel status={status} t={t} />
            <span>
              {t.lastSeen}: {timeAgo(device.last_seen, locale, t)}
            </span>
            {typeof lastMeta.rssi === "number" && (
              <span className="num text-xs">
                {t.signal} {lastMeta.rssi} dBm
              </span>
            )}
          </div>
          {lastMeta.irrigating === true && <p className="mt-2 text-sm text-ice">{t.irrigating}</p>}
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
        {stoma.metrics.map((m) => (
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
          <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-dim">{t.thermalMap}</div>
          <ThermalPlayer
            history={irHistory}
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
            playerLabels={{
              live: t.ir_live,
              demo: t.ir_demo,
              play: t.ir_play,
              pause: t.ir_pause,
              scenarios: {
                normal: { name: t.sc_normal, desc: t.sc_normal_d },
                stress: { name: t.sc_stress, desc: t.sc_stress_d },
                dew: { name: t.sc_dew, desc: t.sc_dew_d },
                hotspot: { name: t.sc_hotspot, desc: t.sc_hotspot_d },
              },
            }}
          />
          {!ir && <p className="mt-2 text-xs text-dim">{t.thermalNone}</p>}
        </div>
        <div className="card flex flex-col gap-5 p-4">
          <div className="text-[11px] uppercase tracking-[0.14em] text-dim">{t.diseaseRisk}</div>
          <RiskBar label={t.risk_botrytis} value={num(lastMeta.humid_h)} warn={cfg.botrytisHours} detail={`${fmt(num(lastMeta.humid_h), 1, locale)} / ${cfg.botrytisHours} h`} />
          <RiskBar label={t.risk_downy} value={num(lastMeta.wet_h)} warn={cfg.downyHours} detail={`${fmt(num(lastMeta.wet_h), 1, locale)} / ${cfg.downyHours} h`} />
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
