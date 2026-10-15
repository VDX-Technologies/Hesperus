import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import { getT, timeAgo } from "@/lib/i18n";
import { alertMessage } from "@/lib/modules";
import { hasUi, MODULE_UI } from "@/components/modules/registry";
import { SectionTitle, StatusDot } from "@/components/ui";

export default async function Overview(props: PageProps<"/o/[slug]">) {
  const { slug } = await props.params;
  const { supabase, org, modules } = await requireOrg(slug);
  const { t, locale } = await getT();
  const { data: alerts } = await supabase
    .from("alerts")
    .select("id, ts, level, code, params, device_id, devices(name)")
    .eq("org_id", org.id)
    .is("resolved_at", null)
    .order("level", { ascending: false })
    .order("ts", { ascending: false })
    .limit(6);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
      <SectionTitle right={<Link href={`/o/${slug}/alerts`} className="text-xs text-mist hover:text-frost">{t.alerts} →</Link>}>
        {t.openAlerts}
      </SectionTitle>
      {alerts?.length ? (
        <ul className="card divide-y divide-line-soft">
          {alerts.map((a) => (
            <li key={a.id}>
              <Link href={`/o/${slug}/devices/${a.device_id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-steel/40">
                <StatusDot status={a.level === "alarm" ? "alarm" : "warn"} pulse />
                <span className="w-28 shrink-0 text-sm text-mist">{(a.devices as unknown as { name: string })?.name}</span>
                <span className="flex-1 text-sm">{alertMessage(a.code, a.params, locale)}</span>
                <span className="text-xs text-dim">{timeAgo(a.ts, locale, t)}</span>
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
        return <W key={m.module} supabase={supabase} orgId={org.id} slug={slug} t={t} locale={locale} />;
      })}
    </div>
  );
}
