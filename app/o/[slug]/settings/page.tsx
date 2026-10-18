import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { listObjects } from "@/lib/packages/console";
import { getPackageDef } from "@/lib/packages/ui";
import { SectionTitle } from "@/components/ui";

/** Every sensor with its own thresholds; each row opens the sensor page to edit them. */
export default async function Settings(props: PageProps<"/o/[slug]/settings">) {
  const { slug } = await props.params;
  const { org, modules } = await requireOrg(slug);
  const { t, locale } = await getT();
  const lists = await Promise.all(modules.map((m) => listObjects(tenantDb(org.id), m.module)));
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.settings}</h1>
      <p className="mt-2 text-sm text-mist">{t.settingsHelp}</p>
      {modules.map((m, i) => {
        const mod = getPackageDef(m.module);
        if (!mod?.settings.length) return null;
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
            <div className="card hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-dim">
                    <th className="px-4 py-3 font-normal">{t.devices}</th>
                    {mod.settings.map((s) => (
                      <th key={s.key} className="px-3 py-3 font-normal">
                        {s.group[locale]}
                        <br />
                        <span className="text-mist">
                          {s.label[locale]} ({s.unit})
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {list.map((d) => {
                    const cfg = { ...base, ...d.config };
                    return (
                      <tr key={d.id} className="hover:bg-steel/40">
                        <td className="px-4 py-3">
                          <Link href={`/o/${slug}/devices/${d.id}#settings`} className="whitespace-nowrap font-medium text-ice hover:underline">
                            {d.name}
                          </Link>
                          <div className="whitespace-nowrap text-xs text-dim">{d.placePath.join(" · ") || t.unassigned}</div>
                        </td>
                        {mod.settings.map((s) => (
                          <td key={s.key} className="num px-3 py-3 text-mist">
                            {Math.round((cfg[s.key] / (s.scale ?? 1)) * 100) / 100}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
