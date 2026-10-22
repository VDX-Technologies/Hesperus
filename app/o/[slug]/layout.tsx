import { requireOrg } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { countOpenAlerts } from "@/lib/packages/console";
import { Header } from "@/components/header";
import { LiveRefresh } from "@/components/live-refresh";
import { ConsentGate } from "@/components/consent-gate";
import { getConsent } from "@/lib/consent";

export default async function OrgLayout(props: LayoutProps<"/o/[slug]">) {
  const { slug } = await props.params;
  const { supabase, user, org, isAdmin, modules } = await requireOrg(slug);
  const { t, locale } = await getT();
  const db = tenantDb(org.id);
  const [count, uploads, consent] = await Promise.all([
    countOpenAlerts(db),
    db.query(`select 1 from sources where tenant_id = $1 and connector = 'upload' limit 1`, [org.id]),
    isAdmin ? null : getConsent(supabase, user.id),
  ]);
  const hasUpload = uploads.rowCount! > 0;
  // VDX staff are not data subjects here; customers sign once, then only Settings changes it
  const mustSign = !isAdmin && !consent;
  return (
    <>
    <div className="min-h-screen lg:pl-64" inert={mustSign}>
      <Header
        title={org.name}
        t={t}
        locale={locale}
        path={`/o/${slug}`}
        isAdmin={isAdmin}
        nav={[
          { href: `/o/${slug}`, label: t.overview },
          { href: `/o/${slug}/alerts`, label: t.alerts, badge: count },
          { href: `/o/${slug}/registers`, label: t.registers },
          ...(modules.some((m) => m.module === "agronomy") ? [{ href: `/o/${slug}/crops`, label: t.crops }] : []),
          ...(hasUpload ? [{ href: `/o/${slug}/upload`, label: t.upload }] : []),
          { href: `/o/${slug}/activity`, label: t.activity },
          { href: `/o/${slug}/settings`, label: t.settings },
        ]}
      />
      <LiveRefresh orgId={org.id} />
      <main className="mx-auto max-w-7xl px-4 pb-16 pt-5 sm:px-6 lg:px-8 lg:pt-7">{props.children}</main>
    </div>
    {mustSign && <ConsentGate slug={slug} email={user.email} t={t} locale={locale} />}
    </>
  );
}
