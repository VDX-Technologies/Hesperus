import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { getModule } from "@/lib/modules";
import { SectionTitle } from "@/components/ui";

/** Every sensor with its own thresholds; each row opens the sensor page to edit them. */
export default async function Settings(props: PageProps<"/o/[slug]/settings">) {
  const { slug } = await props.params;
  const { supabase, org, modules } = await requireOrg(slug);
  const { t, locale } = await getT();
  const { data: devices } = await supabase
    .from("devices")
    .select("id, name, module, config, zones(name)")
    .eq("org_id", org.id)
    .order("name");
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.settings}</h1>
      <p className="mt-2 text-sm text-mist">{t.settingsHelp}</p>
      {modules.map((m) => {
        const mod = getModule(m.module);
        if (!mod?.settings.length) return null;
        const base = { ...(mod.defaultConfig as Record<string, number>), ...((m.config ?? {}) as Record<string, number>) };
        const list = (devices ?? []).filter((d) => d.module === mod.id);
        return (
          <section key={mod.id}>
            <SectionTitle>
              {mod.name} · {t.alarmSettings}
            </SectionTitle>
            <div className="card overflow-x-auto">
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
                    const cfg = { ...base, ...((d.config ?? {}) as Record<string, number>) };
                    return (
                      <tr key={d.id} className="hover:bg-steel/40">
                        <td className="px-4 py-3">
                          <Link href={`/o/${slug}/devices/${d.id}#settings`} className="font-medium text-ice hover:underline">
                            {d.name}
                          </Link>
                          <div className="text-xs text-dim">{(d.zones as unknown as { name: string } | null)?.name ?? t.unassigned}</div>
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
