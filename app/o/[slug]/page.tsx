import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import { getT, timeAgo } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { listAudit } from "@/lib/engine/audit";
import { listAlerts } from "@/lib/packages/console";
import { countLegacyEntries } from "@/lib/packages/agronomy/import";
import { PERIODS, periodFrom } from "@/lib/packages/agronomy/dashboard";
import { hasUi, MODULE_UI } from "@/components/modules/registry";
import { ActivityList } from "@/components/activity-list";
import { ConfirmButton } from "@/components/confirm-button";
import { StatusDot } from "@/components/ui";
import { OpsBoard } from "@/components/ops-board";
import { listEventTypes, label as nameOf } from "@/lib/engine/registers";
import { listUploads } from "@/lib/engine/upload";
import { getPackage } from "@/lib/packages";
import { moveLegacy } from "./upload/actions";

const DAY = 86_400_000;
const btn = "inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-mist hover:border-ice/60 hover:text-frost";

/** The organization's command center: status and actions on top, each module's reading below, alerts and activity alongside. */
export default async function Overview(props: PageProps<"/o/[slug]">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const { org, role, modules } = await requireOrg(slug);
  const { t, locale } = await getT();
  const db = tenantDb(org.id);
  const period = periodFrom(sp.p);
  const agronomy = modules.some((m) => m.module === "agronomy");
  const pkgs = modules.map((m) => getPackage(m.module)).filter((p): p is NonNullable<typeof p> => !!p);
  const [alerts, audit, legacy, types, uploads, allAlerts] = await Promise.all([
    listAlerts(db, locale, { limit: 8 }),
    listAudit(db, { limit: 12 }),
    role === "owner" ? countLegacyEntries(db, org.id) : Promise.resolve(0),
    listEventTypes(db, pkgs),
    listUploads(db, 200),
    listAlerts(db, locale, { limit: 500 }),
  ]);
  const open = alerts.filter((a) => a.status === "open");
  const alarms = open.filter((a) => a.severity === "alarm").length;
  const now = new Date();
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const range = period ? `&from=${day(now.getTime() - (period - 1) * DAY)}&to=${day(now.getTime())}` : "";
  const reg = `/o/${slug}/registers/agronomy.treatment`;
  const periodName = (p: number) => (p ? (p === 365 ? t.db_year : `${p}${t.ov_days}`) : t.db_all);

  return (
    <div className="space-y-5">
      <header className="sticky top-0 z-20 -mx-4 border-b border-line bg-ink-950/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-4">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.2em] text-dim">{t.overview}</div>
              <h1 className="truncate text-xl font-semibold tracking-tight">{org.name}</h1>
            </div>
            <div className="num hidden items-center gap-4 border-l border-line pl-4 text-xs md:flex">
              <span className="flex items-center gap-2">
                <StatusDot status={alarms ? "alarm" : open.length ? "warn" : "ok"} pulse={open.length > 0} />
                <span className="text-mist">{open.length ? `${open.length} ${t.ov_openAlerts}` : t.ov_live}</span>
              </span>
              <span className="text-dim">{modules.length} {t.ov_modules}</span>
              <span className="text-dim">{t.ov_updated} {now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <nav aria-label={t.db_period} className="flex rounded-md border border-line bg-ink-900 p-0.5">
              {PERIODS.map((p) => (
                <Link key={p} href={`/o/${slug}?p=${p}`} scroll={false}
                  className={`num rounded px-2.5 py-1 text-xs ${p === period ? "bg-steel text-frost" : "text-dim hover:text-mist"}`}>
                  {periodName(p)}
                </Link>
              ))}
            </nav>
            {agronomy && <Link href={`${reg}#new`} className="btn">+ {t.db_newTreatment}</Link>}
            {types.length > 0 && (
              <details className="relative">
                <summary className={`${btn} cursor-pointer list-none`}>+ {t.ops_record} ▾</summary>
                <div className="absolute right-0 z-30 mt-1 max-h-80 w-56 overflow-y-auto rounded-md border border-line bg-ink-900 py-1 shadow-xl">
                  {types.map((x) => (
                    <Link key={x.type} href={`/o/${slug}/registers/${x.type}#new`} className="block truncate px-3 py-1.5 text-xs text-mist hover:bg-ink-800 hover:text-frost">
                      {nameOf(x.name, locale, x.type)}
                    </Link>
                  ))}
                </div>
              </details>
            )}
            <Link href={`/o/${slug}/upload`} className={btn}>↑ {t.upload}</Link>
            {agronomy && (
              <>
                <a href={`${reg}/export?format=pdf${range}`} className={btn}>PDF</a>
                <a href={`${reg}/export?format=csv${range}`} className={btn}>CSV</a>
              </>
            )}
            <Link href={`/o/${slug}/alerts`} className={`${btn} ${alarms ? "border-alarm/50 text-alarm" : open.length ? "border-warn/50 text-warn" : ""}`}>
              {t.alerts} <span className="num">{open.length}</span>
            </Link>
          </div>
        </div>
      </header>

      {legacy > 0 && (
        <div className="card flex flex-wrap items-center justify-between gap-4 border-warn/40 p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-warn">{t.legacyTitle} · <span className="num">{legacy}</span></div>
            <p className="mt-1 max-w-2xl text-xs text-mist">{t.legacyHelp}</p>
          </div>
          <form action={moveLegacy}>
            <input type="hidden" name="slug" value={slug} />
            <ConfirmButton message={t.legacyConfirm} className="rounded-md bg-warn px-3 py-1.5 text-xs font-semibold text-ink-950 hover:opacity-90">
              {t.legacyMove}
            </ConfirmButton>
          </form>
        </div>
      )}

      {modules.length === 0 && <p className="text-mist">{t.noModules}</p>}

      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-8">
          <OpsBoard db={db} slug={slug} t={t} locale={locale} period={period} types={types} alerts={allAlerts} uploads={uploads} now={now} />
          {modules.some((m) => hasUi(m.module)) && (
            <div className="border-t border-line pt-5 text-[11px] uppercase tracking-[0.2em] text-dim">{t.ops_detail}</div>
          )}
          {modules.map((m) => {
            if (!hasUi(m.module)) return null;
            const { Overview: W } = MODULE_UI[m.module];
            return <W key={m.module} orgId={org.id} slug={slug} t={t} locale={locale} period={period} />;
          })}
        </div>

        <aside className="space-y-4">
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
              <span className="text-[11px] uppercase tracking-[0.14em] text-dim">{t.openAlerts} · <span className="num">{open.length}</span></span>
              <Link href={`/o/${slug}/alerts`} className="text-xs text-mist hover:text-frost">{t.alerts} →</Link>
            </div>
            {!alerts.length ? (
              <div className="flex items-center gap-2 px-4 py-3 text-sm text-mist"><StatusDot status="ok" /> {t.noAlerts}</div>
            ) : (
              <ul className="divide-y divide-line-soft">
                {alerts.map((a) => (
                  <li key={a.id}>
                    <Link href={`/o/${slug}/devices/${a.objectId}`} className="flex items-start gap-3 px-4 py-2.5 text-sm hover:bg-ink-800">
                      <span className="mt-1.5"><StatusDot status={a.severity === "alarm" ? "alarm" : "warn"} pulse={a.status === "open"} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-frost">{a.object}</span>
                        <span className="block truncate text-xs text-mist">{a.text}</span>
                      </span>
                      <span className="num shrink-0 text-[11px] text-dim">{timeAgo(a.openedAt, locale, t)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card overflow-hidden">
            <div className="border-b border-line-soft px-4 py-2.5 text-[11px] uppercase tracking-[0.14em] text-dim">{t.db_activity}</div>
            <div className="max-h-[520px] overflow-y-auto [&>*]:rounded-none [&>*]:border-0">
              <ActivityList entries={audit} t={t} locale={locale} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
