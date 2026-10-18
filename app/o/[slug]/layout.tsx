import { requireOrg } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { countOpenAlerts } from "@/lib/packages/console";
import { Header } from "@/components/header";
import { LiveRefresh } from "@/components/live-refresh";

export default async function OrgLayout(props: LayoutProps<"/o/[slug]">) {
  const { slug } = await props.params;
  const { org, isAdmin } = await requireOrg(slug);
  const { t, locale } = await getT();
  const count = await countOpenAlerts(tenantDb(org.id));
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
          { href: `/o/${slug}/settings`, label: t.settings },
        ]}
      />
      <LiveRefresh orgId={org.id} />
      <main className="mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6">{props.children}</main>
    </>
  );
}
