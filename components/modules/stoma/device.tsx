import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { stoma } from "@/lib/modules/stoma";
import type { Locale } from "@/lib/modules/types";
import { timeAgo, type Dict } from "@/lib/i18n";
import { fmt, liveStatus, SectionTitle, StatusLabel } from "@/components/ui";
import { TimeChart } from "@/components/chart";

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
  device: Device;
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
        <div className="flex gap-2 text-sm">
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
      </div>
    </div>
  );
}
