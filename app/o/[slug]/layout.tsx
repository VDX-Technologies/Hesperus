import { requireOrg } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { countOpenAlerts } from "@/lib/packages/console";
import { Header } from "@/components/header";
import { LiveRefresh } from "@/components/live-refresh";

export default async function OrgLayout(props: LayoutProps<"/o/[slug]">) {
  const { slug } = await props.params;
  const { org, isAdmin, modules } = await requireOrg(slug);
  const { t, locale } = await getT();
  const db = tenantDb(org.id);
  const [count, uploads] = await Promise.all([
    countOpenAlerts(db),
    db.query(`select 1 from sources where tenant_id = $1 and connector = 'upload' limit 1`, [org.id]),
  ]);
  const hasUpload = uploads.rowCount! > 0;
  return (
    <>
      <Header
        title={org.name}
        t={t}
        locale={locale}
        path={`/o/${slug}`}
        isAdmin={isAdmin}
        nav={[
          { href: `/o/${slug}`, label: t.overview },
          { href: `/o/${slug}/alerts`, label: t.alerts, badge: count },
          ...(modules.some((m) => m.module === "agronomy") ? [{ href: `/o/${slug}/treatments`, label: t.treatments }] : []),
          ...(hasUpload ? [{ href: `/o/${slug}/upload`, label: t.upload }] : []),
          { href: `/o/${slug}/activity`, label: t.activity },
          { href: `/o/${slug}/settings`, label: t.settings },
        ]}
      />
      <LiveRefresh orgId={org.id} />
      <main className="mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6">{props.children}</main>
    </>
  );
}
