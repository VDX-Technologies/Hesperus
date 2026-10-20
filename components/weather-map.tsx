"use client";

import { useMemo, useState } from "react";
import type { GeoGeometry, WeatherAlert, WeatherLocation } from "@/lib/engine/weather";

const SIZE = 256;
const VIEW_WIDTH = 768;
const VIEW_HEIGHT = 512;
const SEVERITY_COLOR = { yellow: "#f2b84b", orange: "#fb873f", red: "#ff5a5f" } as const;

function project(longitude: number, latitude: number, zoom: number) {
  const scale = SIZE * 2 ** zoom;
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180;
  return {
    x: (longitude + 180) / 360 * scale,
    y: (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * scale,
  };
}

function initialView(sites: WeatherLocation[]) {
  if (!sites.length) return { longitude: 12, latitude: 49, zoom: 3 };
  const minLon = Math.min(...sites.map((s) => s.longitude));
  const maxLon = Math.max(...sites.map((s) => s.longitude));
  const minLat = Math.min(...sites.map((s) => s.latitude));
  const maxLat = Math.max(...sites.map((s) => s.latitude));
  const longitude = (minLon + maxLon) / 2;
  const latitude = (minLat + maxLat) / 2;
  const span = Math.max(maxLon - minLon, maxLat - minLat);
  const zoom = span > 50 ? 3 : span > 25 ? 4 : span > 12 ? 5 : span > 5 ? 6 : 7;
  return { longitude, latitude, zoom };
}

function paths(geometry: GeoGeometry, center: { x: number; y: number }, zoom: number): string[] {
  const rings: number[][][][] = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return rings.flatMap((polygon) => polygon.map((ring) => {
    const points = ring.map(([lon, lat]) => {
      const point = project(lon, lat, zoom);
      return `${(point.x - center.x + VIEW_WIDTH / 2).toFixed(1)},${(point.y - center.y + VIEW_HEIGHT / 2).toFixed(1)}`;
    });
    return points.length > 2 ? `M${points.join(" L")} Z` : "";
  })).filter(Boolean);
}

export function WeatherMap({
  sites,
  alerts,
  selectedSiteId,
  onSelectSite,
  labels,
  tileSettings,
}: {
  sites: WeatherLocation[];
  alerts: WeatherAlert[];
  selectedSiteId: string | null;
  onSelectSite: (id: string) => void;
  labels: { map: string; sites: string; warnings: string; site: string };
  tileSettings: { urlTemplate: string; attribution: string; attributionUrl: string };
}) {
  const [view, setView] = useState(() => initialView(sites));
  const [showSites, setShowSites] = useState(true);
  const [showWarnings, setShowWarnings] = useState(true);
  const center = useMemo(() => project(view.longitude, view.latitude, view.zoom), [view]);
  const activeAlerts = useMemo(() => alerts.filter((alert) => alert.status !== "resolved" && alert.geometry), [alerts]);
  const alertsBySite = useMemo(() => {
    const bySite = new Map<string, WeatherAlert[]>();
    for (const alert of activeAlerts) {
      const list = bySite.get(alert.siteId) ?? [];
      list.push(alert);
      bySite.set(alert.siteId, list);
    }
    return bySite;
  }, [activeAlerts]);
  const warningAreas = useMemo(() => {
    const seen = new Set<string>();
    return activeAlerts.filter((alert) => {
      const key = `${alert.sourceFeatureId ?? alert.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [activeAlerts]);
  const warningPaths = useMemo(() => showWarnings
    ? warningAreas.map((alert) => ({ alert, paths: alert.geometry ? paths(alert.geometry, center, view.zoom) : [] }))
    : [], [center, showWarnings, view.zoom, warningAreas]);
  const tileCenterX = Math.floor(center.x / SIZE);
  const tileCenterY = Math.floor(center.y / SIZE);
  const tileCount = 2 ** view.zoom;
  const latitudeDirection = view.latitude >= 0 ? "N" : "S";
  const longitudeDirection = view.longitude >= 0 ? "E" : "W";
  const tiles = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const x = tileCenterX + dx;
      const y = tileCenterY + dy;
      if (y < 0 || y >= tileCount) continue;
      const wrappedX = (x % tileCount + tileCount) % tileCount;
      tiles.push({
        key: `${view.zoom}/${wrappedX}/${y}`,
        src: tileSettings.urlTemplate.replaceAll("{z}", String(view.zoom)).replaceAll("{x}", String(wrappedX)).replaceAll("{y}", String(y)),
        x: x * SIZE - center.x + VIEW_WIDTH / 2,
        y: y * SIZE - center.y + VIEW_HEIGHT / 2,
      });
    }
  }

  function selectSite(site: WeatherLocation) {
    onSelectSite(site.siteId);
    setView((current) => ({
      longitude: site.longitude,
      latitude: site.latitude,
      zoom: Math.max(current.zoom, 6),
    }));
  }

  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3 sm:px-5">
        <div>
          <h2 className="text-sm font-medium">{labels.map}</h2>
          <p className="num mt-0.5 text-[10px] uppercase tracking-[0.12em] text-dim">{Math.abs(view.latitude).toFixed(2)}° {latitudeDirection} · {Math.abs(view.longitude).toFixed(2)}° {longitudeDirection} · Z{view.zoom}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" aria-pressed={showSites} onClick={() => setShowSites((value) => !value)} className={`btn text-xs ${showSites ? "border-ice/60 text-ice" : "text-dim"}`}>{labels.sites}</button>
          <button type="button" aria-pressed={showWarnings} onClick={() => setShowWarnings((value) => !value)} className={`btn text-xs ${showWarnings ? "border-warn/60 text-warn" : "text-dim"}`}>{labels.warnings}</button>
        </div>
      </header>

      <div className="relative aspect-[3/2] min-h-72 bg-ink-950 sm:aspect-[3/1.8]">
        <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="group" aria-label={labels.map}>
          <defs>
            <filter id="weather-map-darken"><feColorMatrix type="saturate" values="0.35" /><feComponentTransfer><feFuncR type="linear" slope="0.72" intercept="0.015" /><feFuncG type="linear" slope="0.78" intercept="0.02" /><feFuncB type="linear" slope="0.82" intercept="0.03" /></feComponentTransfer></filter>
          </defs>
          <g filter="url(#weather-map-darken)" aria-hidden="true">
            {tiles.map((tile) => <image key={tile.key} href={tile.src} x={tile.x} y={tile.y} width={SIZE} height={SIZE} preserveAspectRatio="none" />)}
          </g>
          {warningPaths.map(({ alert, paths: areaPaths }) => (
            <g key={alert.sourceFeatureId ?? alert.id} pointerEvents="none" aria-hidden="true">
              {areaPaths.map((path, i) => (
                <path key={i} d={path} fill={SEVERITY_COLOR[alert.severity]} fillOpacity="0.2" stroke={SEVERITY_COLOR[alert.severity]} strokeWidth="2" strokeOpacity="0.92" />
              ))}
            </g>
          ))}
          {showSites && sites.map((site) => {
            const point = project(site.longitude, site.latitude, view.zoom);
            const x = point.x - center.x + VIEW_WIDTH / 2;
            const y = point.y - center.y + VIEW_HEIGHT / 2;
            const siteAlerts = alertsBySite.get(site.siteId) ?? [];
            const severe = siteAlerts.find((alert) => alert.severity === "red") ?? siteAlerts.find((alert) => alert.severity === "orange") ?? siteAlerts[0];
            const color = severe ? SEVERITY_COLOR[severe.severity] : "#9fd8ff";
            const selected = selectedSiteId === site.siteId;
            return (
              <g key={site.siteId} transform={`translate(${x} ${y})`} onClick={() => selectSite(site)} role="button" tabIndex={0}
                aria-label={`${site.site}${severe ? ` · ${severe.title}` : ""}`} onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectSite(site);
                  }
                }} className="cursor-pointer">
                {selected && <circle r="14" fill={color} fillOpacity="0.16" />}
                <circle r={selected ? 7 : 5.5} fill={color} stroke="#0b0e12" strokeWidth="2" />
                {severe && <circle r="11" fill="none" stroke={color} strokeWidth="1.2" strokeOpacity="0.8"><animate attributeName="r" values="9;14;9" dur="2.8s" repeatCount="indefinite" /><animate attributeName="stroke-opacity" values=".7;.15;.7" dur="2.8s" repeatCount="indefinite" /></circle>}
                <title>{site.site}{severe ? ` · ${severe.title}` : ""}</title>
              </g>
            );
          })}
          <g opacity=".25" pointerEvents="none" stroke="#e9ebee" strokeWidth=".5">
            <path d="M0 256H768M384 0V512" strokeDasharray="2 8" />
          </g>
        </svg>

        <div className="absolute right-3 top-3 grid overflow-hidden rounded-lg border border-line bg-ink-900/90 shadow-lg">
          <button type="button" aria-label="Zoom in" onClick={() => setView((v) => ({ ...v, zoom: Math.min(8, v.zoom + 1) }))} className="px-3 py-1.5 text-lg leading-none text-frost hover:bg-steel">+</button>
          <button type="button" aria-label="Zoom out" onClick={() => setView((v) => ({ ...v, zoom: Math.max(3, v.zoom - 1) }))} className="border-t border-line px-3 py-1.5 text-lg leading-none text-frost hover:bg-steel">−</button>
        </div>
        <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-md border border-line-soft bg-ink-900/90 px-2.5 py-1.5 text-[10px] text-mist">
          <span className="h-2 w-2 rounded-full bg-ice" /> {labels.sites}
          <span className="ml-1 h-2 w-2 rounded-full bg-warn" /> {labels.warnings}
        </div>
      </div>
      <div className="border-t border-line-soft px-4 py-2 text-[10px] text-dim sm:px-5">
        <a href={tileSettings.attributionUrl} target="_blank" rel="noreferrer" className="hover:text-mist">{tileSettings.attribution}</a>
      </div>
    </section>
  );
}
