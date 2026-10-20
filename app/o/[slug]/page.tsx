import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import { getT, timeAgo } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { countOpenAlertSummary, listAlerts, listObjects } from "@/lib/packages/console";
import { countLegacyEntries } from "@/lib/packages/agronomy/import";
import { PERIODS, periodFrom } from "@/lib/packages/agronomy/dashboard";
import { hasUi, MODULE_UI } from "@/components/modules/registry";
import { ConfirmButton } from "@/components/confirm-button";
import { StatusDot } from "@/components/ui";
import { OpsBoard } from "@/components/ops-board";
import { listEventTypes, label as nameOf } from "@/lib/engine/registers";
import { listUploads } from "@/lib/engine/upload";
import { getPackage } from "@/lib/packages";
import { moveLegacy } from "./upload/actions";

const DAY = 86_400_000;
const btn = "inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-mist hover:border-ice/60 hover:text-frost";

/** The organization's command center: current health, priorities and a compact operating picture. */
export default async function Overview(props: PageProps<"/o/[slug]">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const { org, role, modules } = await requireOrg(slug);
  const { t, locale } = await getT();
  const db = tenantDb(org.id);
  const period = periodFrom(sp.p);
  const agronomy = modules.some((m) => m.module === "agronomy");
  const pkgs = modules.map((m) => getPackage(m.module)).filter((p): p is NonNullable<typeof p> => !!p);
  const [legacy, types, uploads, allAlerts, alertCounts, stomaCards] = await Promise.all([
    role === "owner" ? countLegacyEntries(db, org.id) : Promise.resolve(0),
    listEventTypes(db, pkgs),
    listUploads(db, 200),
    listAlerts(db, locale, { limit: 500 }),
    countOpenAlertSummary(db),
    modules.some((m) => m.module === "stoma") ? listObjects(db, "stoma") : Promise.resolve([]),
  ]);
  const offlineCount = stomaCards.filter((d) => d.status === "offline").length;
  const freshest = stomaCards.map((d) => d.lastSeen).filter((x): x is string => !!x).sort().at(-1) ?? null;
  const headerStatus = alertCounts.alarms ? "alarm" : alertCounts.open || offlineCount ? "warn" : "ok";
  const now = new Date();
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const range = period ? `&from=${day(now.getTime() - (period - 1) * DAY)}&to=${day(now.getTime())}` : "";
  const reg = `/o/${slug}/registers/agronomy.treatment`;
  const periodName = (p: number) => (p ? (p === 365 ? t.db_year : `${p}${t.ov_days}`) : t.db_all);

  return (
    <div className="space-y-5">
      <header className="-mx-4 border-b border-line px-4 pb-4 sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.2em] text-dim">{t.overview}</div>
              <h1 className="truncate text-xl font-semibold tracking-tight">{org.name}</h1>
            </div>
            <div className="num flex flex-wrap items-center gap-x-4 gap-y-2 border-l border-line pl-4 text-xs">
              <span className="flex items-center gap-2">
                <StatusDot status={headerStatus} pulse={alertCounts.open > 0 || offlineCount > 0} />
                <span className="text-mist">
                  {alertCounts.alarms ? `${alertCounts.alarms} ${t.ops_alarm}` : offlineCount ? `${offlineCount} ${t.ops_offlineSensors}` : alertCounts.open ? `${alertCounts.open} ${t.ov_openAlerts}` : t.ov_live}
                </span>
              </span>
              <span className="text-dim">{modules.length} {t.ov_modules}</span>
              {freshest && <span className="text-dim">{t.ov_dataAge} {timeAgo(freshest, locale, t)}</span>}
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
              <details className="relative">
                <summary className={`${btn} cursor-pointer list-none`}>{t.ops_export} ▾</summary>
                <div className="absolute right-0 z-30 mt-1 flex w-28 flex-col rounded-md border border-line bg-ink-900 py-1 shadow-xl">
                  <a href={`${reg}/export?format=pdf${range}`} className="px-3 py-1.5 text-xs text-mist hover:bg-ink-800 hover:text-frost">PDF</a>
                  <a href={`${reg}/export?format=csv${range}`} className="px-3 py-1.5 text-xs text-mist hover:bg-ink-800 hover:text-frost">CSV</a>
                </div>
              </details>
            )}
            <Link href={`/o/${slug}/alerts`} className={`${btn} ${alertCounts.alarms ? "border-alarm/50 text-alarm" : alertCounts.open ? "border-warn/50 text-warn" : ""}`}>
              {t.alerts} <span className="num">{alertCounts.open}</span>
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

      <div className="min-w-0 space-y-8">
        <OpsBoard
          db={db} slug={slug} t={t} locale={locale} period={period} types={types} alerts={allAlerts} uploads={uploads}
          health={{ total: stomaCards.length, offline: offlineCount, warn: stomaCards.filter((d) => d.status === "warn").length, alarm: stomaCards.filter((d) => d.status === "alarm").length }}
          openAlertCount={alertCounts.open} openAlarmCount={alertCounts.alarms} now={now}
        />
        {modules.some((m) => hasUi(m.module)) && (
          <section className="space-y-3 border-t border-line pt-5">
            <h2 className="text-xs font-medium uppercase tracking-[0.16em] text-dim">{t.ops_modulesDetails}</h2>
            <div className="space-y-3">
              {modules.map((m) => {
                if (!hasUi(m.module)) return null;
                if (m.module === "stoma") {
                  const W = MODULE_UI.stoma.Overview;
                  return (
                    <details key={m.module} open={offlineCount > 0} className="card overflow-hidden">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm text-frost">
                        <span>Stoma</span>
                        <span className="flex items-center gap-3 text-xs text-mist">
                          {offlineCount > 0 && <span className="inline-flex items-center gap-1.5"><StatusDot status="warn" />{offlineCount} {t.ops_offlineSensors}</span>}
                          <span>{stomaCards.length} {t.devices.toLowerCase()}</span>
                        </span>
                      </summary>
                      <div className="border-t border-line-soft p-4">
                        <W orgId={org.id} slug={slug} t={t} locale={locale} cards={stomaCards} />
                      </div>
                    </details>
                  );
                }
                const { Overview: W } = MODULE_UI[m.module];
                return (
                  <details key={m.module} className="card overflow-hidden">
                    <summary className="cursor-pointer list-none px-4 py-3 text-sm capitalize text-frost">{m.module}</summary>
                    <div className="border-t border-line-soft p-4">
                      <W orgId={org.id} slug={slug} t={t} locale={locale} period={period} />
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
