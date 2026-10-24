import { requireConsole } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { countOpenAlerts } from "@/lib/packages/console";
import { Header } from "@/components/header";
import { LiveRefresh } from "@/components/terra/live-refresh";
import { ConsentGate } from "@/components/consent-gate";
import { getConsent } from "@/lib/consent";
import { Metadata } from "next";
import { enabledConsoles } from "@/lib/consoles";

export const metadata: Metadata = {
  title: { default: "VDX Terra", template: "%s · VDX Terra" },
  description: "One platform for the agri-food sector.",
  appleWebApp: { capable: true, title: "VDX Terra", statusBarStyle: "black-translucent" },
};

export default async function OrgLayout(props: LayoutProps<"/terra/o/[slug]">) {
  const { slug } = await props.params;
  // VDX turns the console on per organization, from the vendor console
  const { supabase, user, org, isAdmin, modules } = await requireConsole(slug, "terra");
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
          path={`/terra/o/${slug}`}
          isAdmin={isAdmin}
          nav={[
            { href: `/terra/o/${slug}`, label: t.overview },
            { href: `/terra/o/${slug}/alerts`, label: t.alerts, badge: count },
            { href: `/terra/o/${slug}/registers`, label: t.registers },
            ...(modules.some((m) => m.module === "agronomy") ? [{ href: `/terra/o/${slug}/crops`, label: t.crops }] : []),
            ...(hasUpload ? [{ href: `/terra/o/${slug}/upload`, label: t.upload }] : []),
            { href: `/terra/o/${slug}/activity`, label: t.activity },
            { href: `/terra/o/${slug}/settings`, label: t.settings },
            ...enabledConsoles(org).filter((c) => c.id !== "terra").map((c) => ({ href: c.href(slug), label: c.name })),
          ]}
        />
        <LiveRefresh orgId={org.id} />
        <main className="mx-auto max-w-7xl px-4 pb-16 pt-5 sm:px-6 lg:px-8 lg:pt-7">{props.children}</main>
      </div>
      {mustSign && <ConsentGate slug={slug} home={`/terra/o/${slug}`} email={user.email} t={t} locale={locale} />}
    </>
  );
}
