import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { getModule } from "@/lib/modules";
import { hasUi, MODULE_UI } from "@/components/modules/registry";
import { SettingsForm } from "@/components/settings-form";
import { Flash } from "@/components/flash";
import { SectionTitle } from "@/components/ui";
import { saveDeviceSettings } from "../../settings/actions";

export default async function DevicePage(props: PageProps<"/o/[slug]/devices/[id]">) {
  const { slug, id } = await props.params;
  const { range, saved, error } = await props.searchParams;
  const { supabase, org, modules, role } = await requireOrg(slug);
  const { t, locale } = await getT();
  const { data: device } = await supabase
    .from("devices")
    .select("id, name, serial, module, config, last_seen, last_status, last_values")
    .eq("org_id", org.id)
    .eq("id", id)
    .maybeSingle();
  if (!device || !hasUi(device.module)) notFound();
  const { Device } = MODULE_UI[device.module];
  const mod = getModule(device.module)!;
  const orgCfg = (modules.find((m) => m.module === mod.id)?.config ?? {}) as Record<string, number>;
  const back = `/o/${slug}/devices/${id}`;
  return (
    <div>
      <Link href={`/o/${slug}`} className="text-sm text-dim hover:text-frost">
        ← {t.overview}
      </Link>
      <div className="mt-4">
        <Device
          supabase={supabase}
          device={device}
          range={range === "7d" ? "7d" : "24h"}
          baseHref={`/o/${slug}/devices/${id}`}
          t={t}
          locale={locale}
        />
      </div>
      {mod.settings.length > 0 && (
        <section id="settings">
          <SectionTitle>{t.deviceSettings}</SectionTitle>
          <p className="mb-3 text-sm text-mist">{t.deviceSettingsHelp}</p>
          <Flash saved={saved} error={error} t={t} />
          <SettingsForm
            mod={mod}
            action={saveDeviceSettings}
            hidden={{ slug, device: id, back }}
            values={(device.config ?? {}) as Record<string, number>}
            inherited={{ ...(mod.defaultConfig as Record<string, number>), ...orgCfg }}
            editable={role === "owner"}
            allowEmpty={false}
            t={t}
            locale={locale}
          />
        </section>
      )}
    </div>
  );
}
