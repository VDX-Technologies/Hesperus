import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { listObjects } from "@/lib/packages/console";
import { getPackageDef } from "@/lib/packages/ui";
import { SectionTitle } from "@/components/ui";
import { Flash } from "@/components/flash";
import type { SettingDef } from "@/lib/packages/types";
import { saveDeviceSettings } from "./actions";

const shown = (v: number | undefined, scale = 1) => (v === undefined ? "" : String(Math.round((v / scale) * 100) / 100));

function groups(settings: SettingDef[]) {
  const out = new Map<string, SettingDef[]>();
  for (const s of settings) out.set(s.group.it + "|" + s.group.en, [...(out.get(s.group.it + "|" + s.group.en) ?? []), s]);
  return [...out.values()].map((items) => [items[0].group, items] as const);
}

/** Every sensor's thresholds side by side, editable in place (one save per sensor). */
export default async function Settings(props: PageProps<"/o/[slug]/settings">) {
  const { slug } = await props.params;
  const { saved, error } = await props.searchParams;
  const { org, modules, role } = await requireOrg(slug);
  const editable = role === "owner";
  const back = `/o/${slug}/settings`;
  const { t, locale } = await getT();
  const lists = await Promise.all(modules.map((m) => listObjects(tenantDb(org.id), m.module)));
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.settings}</h1>
      <p className="mt-2 text-sm text-mist">{t.settingsHelp}</p>
      <div className="mt-4">
        <Flash saved={saved} error={error} t={t} />
      </div>
      {modules.map((m, i) => {
        const mod = getPackageDef(m.module);
        if (!mod?.settings.length) return null;
        const defaults = mod.defaults as Record<string, number>;
        const base = { ...(mod.defaults as Record<string, number>), ...((m.config ?? {}) as Record<string, number>) };
        const list = lists[i].map((o) => ({ ...o, config: (o.properties.config ?? {}) as Record<string, number> }));
        return (
          <section key={mod.id}>
            <SectionTitle>
              {mod.name} · {t.alarmSettings}
            </SectionTitle>
            {/* phones: one card per sensor */}
            <div className="grid gap-3 md:hidden">
              {list.map((d) => {
                const cfg = { ...base, ...d.config };
                return (
                  <Link key={d.id} href={`/o/${slug}/devices/${d.id}#settings`} className="card block p-4 active:bg-steel/40">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium text-ice">{d.name}</span>
                      <span className="text-xs text-dim">{d.placePath.join(" · ") || t.unassigned}</span>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                      {mod.settings.map((s) => (
                        <div key={s.key} className="flex flex-col">
                          <dt className="truncate text-dim">{s.label[locale]}</dt>
                          <dd className={`num ${cfg[s.key] !== base[s.key] || d.config[s.key] !== undefined ? "text-frost" : "text-mist"}`}>
                            {Math.round((cfg[s.key] / (s.scale ?? 1)) * 100) / 100} {s.unit}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </Link>
                );
              })}
            </div>
            {/* desktop: thresholds as rows (grouped), sensors as columns, edited in place */}
            {list.length > 0 && (
              <div className="card hidden overflow-x-auto md:block">
                {list.map((d) => (
                  <form key={d.id} id={`thr-${d.id}`} action={saveDeviceSettings} className="hidden">
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="device" value={d.id} />
                    <input type="hidden" name="back" value={back} />
                  </form>
                ))}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line-soft text-left text-xs">
                      <th className="px-4 py-2.5 font-normal text-dim">{t.devices}</th>
                      {list.map((d) => (
                        <th key={d.id} className="px-2 py-2.5 font-normal">
                          <Link href={`/o/${slug}/devices/${d.id}#settings`} className="block whitespace-nowrap font-medium text-ice hover:underline">
                            {d.name}
                          </Link>
                          <span className="block whitespace-nowrap text-dim">{d.placePath.join(" · ") || t.unassigned}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  {groups(mod.settings).map(([group, items]) => (
                    <tbody key={group[locale]}>
                      <tr>
                        <td colSpan={list.length + 1} className="px-4 pb-1 pt-3 text-[11px] uppercase tracking-[0.14em] text-dim">
                          {group[locale]}
                        </td>
                      </tr>
                      {items.map((s) => (
                        <tr key={s.key} className="hover:bg-steel/30">
                          <td className="px-4 py-1 text-xs text-mist">
                            <span title={s.help?.[locale]}>{s.label[locale]}</span>
                          </td>
                          {list.map((d) => {
                            const v = d.config[s.key] ?? base[s.key];
                            return (
                              <td key={d.id} className="px-2 py-1">
                                <span className="relative inline-flex w-28 items-center">
                                  <input
                                    form={`thr-${d.id}`}
                                    name={s.key}
                                    type="number"
                                    inputMode="decimal"
                                    step={s.step}
                                    min={s.min}
                                    max={s.max}
                                    required
                                    disabled={!editable}
                                    defaultValue={shown(v, s.scale)}
                                    className={`num w-full py-1 pr-10 text-sm disabled:opacity-60 ${v !== defaults[s.key] ? "text-ice" : ""}`}
                                  />
                                  <span className="pointer-events-none absolute right-2.5 text-[11px] text-dim">{s.unit}</span>
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  ))}
                  {editable && (
                    <tfoot>
                      <tr className="border-t border-line-soft">
                        <td />
                        {list.map((d) => (
                          <td key={d.id} className="px-2 py-3">
                            <button form={`thr-${d.id}`} className="rounded-lg bg-frost px-3 py-1.5 text-xs font-medium text-ink-950 hover:bg-white">
                              {t.save}
                            </button>
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
