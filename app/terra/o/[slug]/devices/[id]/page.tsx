import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { listObjects } from "@/lib/packages/console";
import { listAudit } from "@/lib/engine/audit";
import { ActivityList } from "@/components/activity-list";
import { getPackageDef } from "@/lib/packages/ui";
import { hasUi, MODULE_UI } from "@/components/terra/modules/registry";
import { SettingsForm } from "@/components/settings-form";
import { Flash } from "@/components/terra/flash";
import { SectionTitle } from "@/components/ui";
import { saveDeviceSettings } from "../../settings/actions";

export default async function DevicePage(props: PageProps<"/terra/o/[slug]/devices/[id]">) {
  const { slug, id } = await props.params;
  const { range, saved, error } = await props.searchParams;
  const { org, modules, role } = await requireOrg(slug);
  const { t, locale } = await getT();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = tenantDb(org.id);
  const { rows } = await db.query<{ module: string }>(
    `select t.module from objects o join object_types t on t.id = o.type_id where o.tenant_id = $1 and o.id = $2`,
    [org.id, id],
  );
  const pkg = rows[0]?.module;
  const mod = pkg ? getPackageDef(pkg) : undefined;
  if (!pkg || !mod || !hasUi(pkg)) notFound();
  const [[device], history] = await Promise.all([listObjects(db, pkg, id), listAudit(db, { objectId: id, limit: 20 })]);
  if (!device) notFound();
  const { Device } = MODULE_UI[pkg];
  const orgCfg = (modules.find((m) => m.module === mod.id)?.config ?? {}) as Record<string, number>;
  const back = `/terra/o/${slug}/devices/${id}`;
  return (
    <div>
      <Link href={`/terra/o/${slug}`} className="text-sm text-dim hover:text-frost">
        ← {t.overview}
      </Link>
      <div className="mt-4">
        <Device
          orgId={org.id}
          device={device}
          range={range === "7d" ? "7d" : "24h"}
          baseHref={`/terra/o/${slug}/devices/${id}`}
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
            values={(device.properties.config ?? {}) as Record<string, number>}
            inherited={{ ...(mod.defaults as Record<string, number>), ...orgCfg }}
            editable={role === "owner"}
            allowEmpty={false}
            t={t}
            locale={locale}
          />
        </section>
      )}
      <SectionTitle>{t.objectHistory}</SectionTitle>
      <ActivityList entries={history} t={t} locale={locale} />
    </div>
  );
}
