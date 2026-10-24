import Link from "next/link";
import { tenantDb } from "@/lib/engine/db";
import { series } from "@/lib/engine/query";
import type { ConsoleObject } from "@/lib/packages/console";
import { listCrops, listTreatments, sensorsInPlace } from "@/lib/packages/agronomy/console";
import { PHASE_LABELS, CROP_PROPERTIES } from "@/lib/packages/agronomy";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";
import { fmt, SectionTitle } from "@/components/ui";
import { TimeChart } from "@/components/terra/chart";
import { TreatmentRows } from "./rows";

/** Crop page: its details, the treatments on it, and the climate of the area when a LoRa sensor is there. */
export async function AgronomyDevice({ orgId, device, baseHref, t, locale }: {
  orgId: string; device: ConsoleObject; range: "24h" | "7d"; baseHref: string; t: Dict; locale: Locale;
}) {
  const db = tenantDb(orgId);
  const slug = baseHref.split("/")[2];
  const crops = await listCrops(db);
  const crop = crops.find((c) => c.id === device.id);
  const [rows, sensors] = await Promise.all([listTreatments(db, { cropId: device.id }, crops, 200), sensorsInPlace(db, device.placeId)]);
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 86400000);
  const charts = await Promise.all(
    sensors.map(async (s) => {
      const h = await series(db, { objectId: s.id, module: "lora", metrics: ["rh", "wet_h"], from, to: now });
      const byTs = new Map<number, Record<string, number>>();
      for (const [k, pts] of Object.entries(h.series))
        for (const p of pts) {
          const ts = p.ts.getTime();
          const row = byTs.get(ts) ?? { t: ts };
          row[k] = p.value;
          byTs.set(ts, row);
        }
      return { sensor: s, rows: [...byTs.values()].sort((a, b) => a.t - b.t) };
    }),
  );
  const p = device.properties;
  const day = (v: unknown) => (typeof v === "string" && v ? new Date(v).toLocaleDateString(locale) : "—");
  const facts: [string, string][] = [
    [CROP_PROPERTIES.species.label![locale], String(p.species ?? "—")],
    [CROP_PROPERTIES.variety.label![locale], String(p.variety ?? "—")],
    [CROP_PROPERTIES.hectares.label![locale], fmt(typeof p.hectares === "number" ? p.hectares : null, 2, locale)],
    [CROP_PROPERTIES.phase.label![locale], crop?.phase ? PHASE_LABELS[crop.phase][locale] : "—"],
    [CROP_PROPERTIES.start.label![locale], day(p.start)],
    [CROP_PROPERTIES.end.label![locale], day(p.end)],
  ];
  return (
    <div>
      <div className="text-xs text-dim">{t.crop}{device.placePath.length ? ` · ${device.placePath.join(" / ")}` : ""}</div>
      <h1 className="text-2xl font-semibold tracking-tight">{device.name}</h1>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {facts.map(([k, v]) => (
          <div key={k} className="card p-3">
            <div className="text-[11px] text-dim">{k}</div>
            <div className="mt-1">{v}</div>
          </div>
        ))}
      </div>
      <SectionTitle right={<Link href={`/terra/o/${slug}/registers/agronomy.treatment?obj=${device.id}`} className="text-xs text-frost hover:underline">{t.treatmentsRegister} →</Link>}>
        {t.cropTimeline}
      </SectionTitle>
      <TreatmentRows rows={rows} locale={locale} t={t} />
      {charts.length > 0 && (
        <>
          <SectionTitle>{t.cropClimate}</SectionTitle>
          <div className="grid gap-3 lg:grid-cols-2">
            {charts.map(({ sensor, rows }) => (
              <div key={sensor.id} className="card p-4">
                <div className="mb-2 text-xs text-dim">{sensor.name}</div>
                <TimeChart
                  rows={rows}
                  locale={locale}
                  unitLeft="%"
                  unitRight=" h"
                  series={[
                    { key: "rh", label: "RH", color: "#9fd8ff" },
                    { key: "wet_h", label: locale === "it" ? "Bagnatura" : "Leaf wetness", color: "#3ddc84", axis: "right" },
                  ]}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
