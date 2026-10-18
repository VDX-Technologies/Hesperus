import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import { getT, timeAgo } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { listAlerts } from "@/lib/packages/console";
import { hasUi, MODULE_UI } from "@/components/modules/registry";
import { SectionTitle, StatusDot } from "@/components/ui";

export default async function Overview(props: PageProps<"/o/[slug]">) {
  const { slug } = await props.params;
  const { org, modules } = await requireOrg(slug);
  const { t, locale } = await getT();
  const alerts = await listAlerts(tenantDb(org.id), locale, { limit: 6 });

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
      <SectionTitle right={<Link href={`/o/${slug}/alerts`} className="text-xs text-mist hover:text-frost">{t.alerts} →</Link>}>
        {t.openAlerts}
      </SectionTitle>
      {alerts.length ? (
        <ul className="card divide-y divide-line-soft">
          {alerts.map((a) => (
            <li key={a.id}>
              <Link href={`/o/${slug}/devices/${a.objectId}`} className="flex items-start gap-3 px-5 py-3 hover:bg-steel/40 sm:items-center">
                <span className="mt-1.5 sm:mt-0">
                  <StatusDot status={a.severity === "alarm" ? "alarm" : "warn"} pulse={a.status === "open"} />
                </span>
                <span className="flex flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                  <span className="text-sm text-mist sm:w-28 sm:shrink-0">{a.object}</span>
                  <span className="flex-1 text-sm">{a.text}</span>
                  <span className="text-xs text-dim">{timeAgo(a.openedAt, locale, t)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="card flex items-center gap-3 px-5 py-4 text-sm text-mist">
          <StatusDot status="ok" /> {t.noAlerts}
        </p>
      )}

      {modules.length === 0 && <p className="mt-10 text-mist">{t.noModules}</p>}
      {modules.map((m) => {
        if (!hasUi(m.module)) return null;
        const { Overview: W } = MODULE_UI[m.module];
        return <W key={m.module} orgId={org.id} slug={slug} t={t} locale={locale} />;
      })}
    </div>
  );
}
