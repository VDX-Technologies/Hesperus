import Link from "next/link";
import { tenantDb } from "@/lib/engine/db";
import { listObjects, type ConsoleObject } from "@/lib/packages/console";
import { stoma } from "@/lib/packages/stoma/model";
import type { Locale } from "@/lib/packages/types";
import { timeAgo, type Dict } from "@/lib/i18n";
import { fmt, SectionTitle, StatusDot } from "@/components/ui";

type Values = Record<string, number | null>;

const KEY_METRICS = ["temp_c", "rh", "leaf_c", "cond_margin", "vpd_kpa", "co2"];

/** Stoma widget on the organization overview: one card per sensor, grouped by place. */
export async function StomaOverview({ orgId, slug, t, locale }: { orgId: string; slug: string; t: Dict; locale: Locale; period?: number }) {
  const cards = await listObjects(tenantDb(orgId), "stoma");
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
    <section>
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
