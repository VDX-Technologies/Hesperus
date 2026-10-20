"use client";

import { useMemo, useState } from "react";
import type { WeatherAlert, WeatherLocation } from "@/lib/engine/weather";
import { WeatherMap } from "@/components/weather-map";
import type { WeatherTileSettings } from "@/lib/weather-tiles";

type Action = (formData: FormData) => void | Promise<void>;

function shortTime(value: string | null, locale: string) {
  if (!value) return "–";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "–" : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

const severityText = { yellow: "text-warn", orange: "text-[#fb873f]", red: "text-alarm" } as const;
const severityBorder = { yellow: "border-warn/40", orange: "border-[#fb873f]/50", red: "border-alarm/50" } as const;
const severityBar = { yellow: "bg-warn", orange: "bg-[#fb873f]", red: "bg-alarm" } as const;
const precisionKeys = {
  building: "weatherPrecisionBuilding",
  street: "weatherPrecisionStreet",
  postcode: "weatherPrecisionPostcode",
  locality: "weatherPrecisionLocality",
  region: "weatherPrecisionRegion",
  manual: "weatherPrecisionManual",
} as const;

function freshness(sites: WeatherLocation[], labels: { never: string; stale: string }) {
  const valid = sites.map((site) => site.lastSuccessAt).filter((value): value is string => !!value).sort();
  if (!valid.length) return { text: labels.never, stale: true, value: null };
  const latest = valid.at(-1)!;
  const stale = sites.some((site) => !site.lastSuccessAt || Date.now() - Date.parse(site.lastSuccessAt) > 30 * 60_000);
  return { text: stale ? labels.stale : latest, stale, value: latest };
}

export function WeatherCenter({
  slug,
  sites,
  alerts,
  history,
  subscriptionEnabled,
  canAcknowledge,
  canRefresh,
  locale,
  labels,
  tileSettings,
  refreshAction,
  subscriptionAction,
  acknowledgeAction,
}: {
  slug: string;
  sites: WeatherLocation[];
  alerts: WeatherAlert[];
  history: WeatherAlert[];
  subscriptionEnabled: boolean;
  canAcknowledge: boolean;
  canRefresh: boolean;
  locale: string;
  labels: Record<string, string>;
  tileSettings: WeatherTileSettings;
  refreshAction: Action;
  subscriptionAction: Action;
  acknowledgeAction: Action;
}) {
  const enabledSites = sites.filter((site) => site.enabled);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const selectedSite = enabledSites.find((site) => site.siteId === selectedSiteId) ?? null;
  const visibleAlerts = alerts.filter((alert) => !selectedSiteId || alert.siteId === selectedSiteId);
  const activeAlertsBySite = useMemo(() => {
    const bySite = new Map<string, WeatherAlert[]>();
    for (const alert of alerts) {
      if (alert.status === "resolved") continue;
      const list = bySite.get(alert.siteId) ?? [];
      list.push(alert);
      bySite.set(alert.siteId, list);
    }
    return bySite;
  }, [alerts]);
  const activeSitesCount = activeAlertsBySite.size;
  const severeCount = alerts.filter((alert) => alert.status !== "resolved" && alert.severity !== "yellow").length;
  const latest = freshness(enabledSites, { never: labels.weatherNeverUpdated, stale: labels.weatherStale });
  const sourceErrorSites = enabledSites.filter((site) => site.lastError);

  const timeline = useMemo(() => {
    const now = Date.now();
    const horizon = now + 24 * 60 * 60_000;
    return visibleAlerts.map((alert) => {
      const start = Math.max(now, Date.parse(alert.startsAt ?? alert.issuedAt ?? new Date(now).toISOString()));
      const end = Math.min(horizon, Date.parse(alert.endsAt ?? new Date(horizon).toISOString()));
      const left = Math.max(0, Math.min(100, ((start - now) / (horizon - now)) * 100));
      const right = Math.max(left + 2, Math.min(100, ((end - now) / (horizon - now)) * 100));
      return { ...alert, left, width: Math.max(2, right - left) };
    });
  }, [visibleAlerts]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.16em] text-ice">
            <span className="h-1.5 w-1.5 rounded-full bg-ice" /> {labels.weatherOfficial}
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{labels.weatherConsole}</h1>
          <p className="mt-1 text-sm text-mist">{labels.weatherSubtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form action={subscriptionAction}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="enabled" value={subscriptionEnabled ? "0" : "1"} />
            <button className={`btn text-xs ${subscriptionEnabled ? "border-ok/50 text-ok" : "text-mist"}`}>
              {subscriptionEnabled ? labels.weatherNotifyOff : labels.weatherNotify}
            </button>
          </form>
          {canRefresh && (
            <form action={refreshAction}>
              <input type="hidden" name="slug" value={slug} />
              <button className="btn text-xs">↻ {labels.weatherRefresh}</button>
            </form>
          )}
        </div>
      </div>

      {subscriptionEnabled && <p className="mt-2 text-xs text-dim">{labels.weatherNotifyHelp}</p>}

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-[0.12em] text-dim">{labels.weatherSitesMonitored}</div>
          <div className="num mt-2 text-2xl font-medium">{enabledSites.length.toString().padStart(2, "0")}</div>
        </div>
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-[0.12em] text-dim">{labels.weatherSitesWithWarnings}</div>
          <div className={`num mt-2 text-2xl font-medium ${activeSitesCount ? "text-warn" : "text-ok"}`}>{activeSitesCount.toString().padStart(2, "0")}</div>
        </div>
        <div className="card p-4">
          <div className="text-[10px] uppercase tracking-[0.12em] text-dim">{labels.weatherLastUpdate}</div>
          <div className={`mt-2 text-sm font-medium ${latest.stale ? "text-warn" : "text-ok"}`}>
            {latest.stale ? latest.text : shortTime(latest.value, locale)}
          </div>
          {severeCount > 0 && <div className="mt-1 text-xs text-alarm">{severeCount} · {labels.weatherOpenAlerts}</div>}
        </div>
      </div>

      {!!sourceErrorSites.length && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warn/40 bg-warn/5 px-4 py-3 text-xs">
          <span className="font-medium text-warn">{labels.weatherSourceError} · {sourceErrorSites.length}</span>
          <span className="text-mist">{sourceErrorSites.map((site) => site.site).join(" · ")}</span>
          <span className="text-dim">{labels.weatherStale}</span>
        </div>
      )}

      {!enabledSites.length ? (
        <div className="card mt-6 p-8 text-center">
          <div className="text-sm text-mist">{labels.weatherNoLocations}</div>
        </div>
      ) : (
        <div className="mt-6 grid items-start gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(280px,0.8fr)]">
          <WeatherMap
            sites={enabledSites}
            alerts={alerts}
            selectedSiteId={selectedSiteId}
            onSelectSite={(id) => setSelectedSiteId((current) => current === id ? null : id)}
            labels={{ map: labels.weatherMap, sites: labels.weatherLayerSites, warnings: labels.weatherLayerAlerts, site: labels.site }}
            tileSettings={tileSettings}
          />

          <aside className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
              <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-dim">{labels.sites}</h2>
              {selectedSite && <button type="button" onClick={() => setSelectedSiteId(null)} className="text-xs text-ice hover:underline">{labels.weatherLayerSites} ×</button>}
            </div>
            <div className="max-h-[22rem] divide-y divide-line-soft overflow-y-auto">
              {enabledSites.map((site) => {
                const siteAlerts = activeAlertsBySite.get(site.siteId) ?? [];
                const worst = siteAlerts.find((alert) => alert.severity === "red") ?? siteAlerts.find((alert) => alert.severity === "orange") ?? siteAlerts[0];
                const active = selectedSiteId === site.siteId;
                return (
                  <button key={site.siteId} type="button" onClick={() => setSelectedSiteId(active ? null : site.siteId)} className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-steel/50 ${active ? "bg-steel/50" : ""}`}>
                    <span className={`relative flex h-2.5 w-2.5 shrink-0 rounded-full ${worst ? severityBar[worst.severity] : "bg-ice"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{site.site}</span>
                      <span className="block truncate text-xs text-dim">{site.normalizedAddress.split(",").slice(0, 2).join(",")}</span>
                      <span className="mt-0.5 block text-[10px] text-dim">{labels[precisionKeys[site.precision]]}</span>
                    </span>
                    {worst ? <span className={`text-[10px] uppercase ${severityText[worst.severity]}`}>{worst.severity}</span> : <span className="text-[10px] text-ok">OK</span>}
                  </button>
                );
              })}
            </div>
            {selectedSite && (
              <div className="border-t border-line-soft bg-ink-900/40 px-4 py-3 text-xs">
                <div className="text-dim">{labels.weatherPrecision}</div>
                <div className="mt-1 text-mist">{labels[precisionKeys[selectedSite.precision]]} · {selectedSite.countryCode}</div>
                <p className="mt-2 leading-relaxed text-dim">{labels.weatherPrecisionHelp}</p>
                <a href={`https://www.openstreetmap.org/#map=13/${selectedSite.latitude}/${selectedSite.longitude}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-ice hover:underline">
                  {labels.weatherCheckPin} ↗
                </a>
              </div>
            )}
          </aside>
        </div>
      )}

      {!!enabledSites.length && (
        <section className="mt-7">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-dim">{labels.weatherOpenAlerts}</h2>
              {selectedSite && <p className="mt-1 text-xs text-mist">{labels.site}: {selectedSite.site}</p>}
            </div>
            <a href="https://www.meteoalarm.org/" target="_blank" rel="noreferrer" className="text-xs text-dim hover:text-ice">{labels.weatherSourceName} ↗</a>
          </div>

          {timeline.length ? (
            <div className="space-y-3">
              {timeline.map((alert) => (
                <article key={alert.id} className={`card overflow-hidden border-l-2 ${severityBorder[alert.severity]}`}>
                  <div className="p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.1em]">
                          <span className={severityText[alert.severity]}>{alert.severity}</span>
                          <span className="text-dim">·</span>
                          <span className="text-mist">{alert.site}</span>
                          {alert.status === "acknowledged" && <span className="text-ok">· {labels.weatherAcknowledged}</span>}
                        </div>
                        <h3 className="mt-1.5 text-base font-medium">{alert.title}</h3>
                        <p className="mt-1 text-xs text-dim">{labels.weatherHazard}: {alert.hazard}</p>
                        {alert.description && <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-mist">{alert.description}</p>}
                      </div>
                      {canAcknowledge && alert.status === "open" && (
                        <form action={acknowledgeAction} className="shrink-0">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="id" value={alert.id} />
                          <button className="btn text-xs">{labels.weatherAcknowledge}</button>
                        </form>
                      )}
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div>
                        <div className="flex justify-between gap-3 text-[10px] text-dim">
                          <span>{labels.weatherValidFrom}: {shortTime(alert.startsAt, locale)}</span>
                          <span>{labels.weatherValidUntil}: {shortTime(alert.endsAt, locale)}</span>
                        </div>
                        <div className="relative mt-2 h-1.5 rounded-full bg-line">
                          <div className={`absolute top-0 h-1.5 rounded-full ${severityBar[alert.severity]}`} style={{ left: `${alert.left}%`, width: `${alert.width}%` }} />
                          <div className="absolute -top-1 h-3.5 w-px bg-frost/70" style={{ left: "0%" }} />
                        </div>
                      </div>
                      <div className="flex items-end justify-between gap-3 text-[10px] text-dim">
                        <span>{labels.weatherSourceName}</span>
                        <span>{shortTime(alert.issuedAt ?? alert.acquiredAt, locale)}</span>
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="card p-5 text-sm text-mist">{enabledSites.length ? labels.weatherNoAlerts : labels.weatherNoSiteAddress}</div>
          )}
        </section>
      )}

      {!!history.length && (
        <details className="mt-7">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.14em] text-dim hover:text-frost">{labels.weatherHistory} · {history.length}</summary>
          <div className="card mt-3 divide-y divide-line-soft">
            {history.map((alert) => (
              <div key={alert.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="text-mist">{alert.site} · {alert.title}</span>
                <span className="text-xs text-dim">{alert.severity} · {shortTime(alert.issuedAt ?? alert.acquiredAt, locale)}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3 text-[10px] text-dim">
        <span>{labels.weatherSourceName}</span>
        <span>{labels.weatherLicense}</span>
      </div>
    </div>
  );
}
