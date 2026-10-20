import "server-only";
import type { Pool } from "pg";
import type { TenantDb } from "./db";
import type { Mailer } from "./mail";

const METEOGATE_WARNINGS = "https://api.meteogate.eu/warnings/collections/warnings/locations";
const METEOGATE_ORIGIN = "https://api.meteogate.eu";
const METEOALARM_HOME = "https://www.meteoalarm.org/";
const OPENSTREETMAP_SEARCH = "https://www.openstreetmap.org/search";
const COUNTRY_CACHE_MS = 9 * 60_000;
const COUNTRY_RETRY_MS = 2 * 60_000;

let geocoderLastRequestAt = 0;
let geocoderQueue: Promise<void> = Promise.resolve();

async function waitForGeocoderSlot() {
  const previous = geocoderQueue;
  let release!: () => void;
  geocoderQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const delay = 1_100 - (Date.now() - geocoderLastRequestAt);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  geocoderLastRequestAt = Date.now();
  release();
}

export type GeoPrecision = "building" | "street" | "postcode" | "locality" | "region" | "manual";

export interface WeatherLocation {
  siteId: string;
  site: string;
  address: string;
  normalizedAddress: string;
  latitude: number;
  longitude: number;
  countryCode: string;
  precision: GeoPrecision;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface WeatherAlert {
  id: number;
  siteId: string;
  site: string;
  hazard: string;
  severity: "yellow" | "orange" | "red";
  status: "open" | "acknowledged" | "resolved";
  title: string;
  description: string | null;
  issuedAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  acquiredAt: string;
  sourceUrl: string;
  geometry: GeoGeometry | null;
  sourceFeatureId: string | null;
}

export interface GeoPosition {
  type: "Point";
  coordinates: [number, number];
}

export type GeoGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

type RawFeature = {
  id?: string | number;
  type?: string;
  geometry?: unknown;
  properties?: Record<string, unknown>;
  links?: Array<{ rel?: string; href?: string; type?: string }>;
};

type CapInfo = {
  language?: unknown;
  category?: unknown;
  event?: unknown;
  severity?: unknown;
  effective?: unknown;
  onset?: unknown;
  expires?: unknown;
  headline?: unknown;
  description?: unknown;
  parameter?: unknown;
};

type ParsedWarning = {
  externalId: string;
  featureId: string;
  hazard: string;
  severity: "yellow" | "orange" | "red";
  title: string;
  description: string | null;
  issuedAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  sourceGeometry: GeoGeometry;
  sourceData: Record<string, unknown>;
};

const object = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const values = (v: unknown): unknown[] => v == null ? [] : Array.isArray(v) ? v : [v];

function validString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function validDate(value: unknown): string | null {
  const raw = validString(value);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function precisionForNominatim(type: string, addressType: string): Exclude<GeoPrecision, "manual"> {
  const normalized = `${type} ${addressType}`.toLowerCase();
  if (/house|building|apartments|residential/.test(normalized)) return "building";
  if (/road|street|way|path/.test(normalized)) return "street";
  if (/postcode/.test(normalized)) return "postcode";
  if (/city|town|village|hamlet|municipality/.test(normalized)) return "locality";
  return "region";
}

/** Geocodes only on explicit admin saves; resolved site coordinates are persisted for later reads. */
export async function geocodeWeatherAddress(address: string): Promise<{
  normalizedAddress: string;
  latitude: number;
  longitude: number;
  countryCode: string;
  precision: Exclude<GeoPrecision, "manual">;
}> {
  const query = address.trim().replace(/\s+/g, " ");
  if (query.length < 5 || query.length > 300) throw new Error("Inserisci un indirizzo completo (5–300 caratteri).");
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({ q: query, format: "jsonv2", addressdetails: "1", limit: "1" }).toString();
  await waitForGeocoderSlot();
  const contact = process.env.WEATHER_GEOCODER_CONTACT?.trim();
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": `VDX Core weather geocoder/1.0 (+https://vdxtechnologies.com${contact ? `; ${contact}` : ""})`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Geocodifica non disponibile (HTTP ${response.status}). Riprova più tardi.`);
  const matches: unknown = await response.json();
  if (!Array.isArray(matches) || !matches.length) throw new Error("Indirizzo non trovato: controlla il testo e riprova.");
  const match = object(matches[0]);
  const lat = Number(match?.lat);
  const lon = Number(match?.lon);
  const addressParts = object(match?.address);
  const countryCode = validString(addressParts?.country_code)?.toUpperCase();
  const normalizedAddress = validString(match?.display_name);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !normalizedAddress || !countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
    throw new Error("Il servizio cartografico non ha restituito coordinate affidabili per questo indirizzo.");
  }
  return {
    normalizedAddress,
    latitude: lat,
    longitude: lon,
    countryCode,
    precision: precisionForNominatim(validString(match?.type) ?? "", validString(match?.addresstype) ?? ""),
  };
}

/** Resolve the country for an admin-adjusted pin so country feeds match the actual coordinates. */
export async function countryCodeForWeatherPoint(latitude: number, longitude: number): Promise<string> {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Coordinate non valide.");
  }
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.search = new URLSearchParams({
    lat: String(latitude), lon: String(longitude), format: "jsonv2", addressdetails: "1", zoom: "3",
  }).toString();
  await waitForGeocoderSlot();
  const contact = process.env.WEATHER_GEOCODER_CONTACT?.trim();
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": `VDX Core weather geocoder/1.0 (+https://vdxtechnologies.com${contact ? `; ${contact}` : ""})`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Verifica del paese non disponibile (HTTP ${response.status}). Riprova più tardi.`);
  const result: unknown = await response.json();
  const address = object(object(result)?.address);
  const countryCode = validString(address?.country_code)?.toUpperCase();
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
    throw new Error("Non è stato possibile verificare il paese delle coordinate inserite.");
  }
  return countryCode;
}

export async function listWeatherLocations(db: TenantDb): Promise<WeatherLocation[]> {
  const { rows } = await db.query<{
    site_id: string; site: string | null; address: string; normalized_address: string;
    latitude: number; longitude: number; country_code: string; geocode_precision: GeoPrecision;
    enabled: boolean; last_checked_at: Date | null; last_success_at: Date | null; last_error: string | null;
  }>(
    `select w.site_id, o.name site, w.address, w.normalized_address, w.latitude, w.longitude,
            w.country_code, w.geocode_precision, w.enabled, w.last_checked_at, w.last_success_at, w.last_error
       from weather_locations w
       join objects o on o.tenant_id = w.tenant_id and o.id = w.site_id
      where w.tenant_id = $1 order by o.name`,
    [db.tenantId],
  );
  return rows.map((r) => ({
    siteId: r.site_id,
    site: r.site ?? r.address,
    address: r.address,
    normalizedAddress: r.normalized_address,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    countryCode: r.country_code,
    precision: r.geocode_precision,
    enabled: r.enabled,
    lastCheckedAt: r.last_checked_at?.toISOString() ?? null,
    lastSuccessAt: r.last_success_at?.toISOString() ?? null,
    lastError: r.last_error,
  }));
}

export async function listWeatherAlerts(db: TenantDb, opts: { history?: boolean; limit?: number } = {}): Promise<WeatherAlert[]> {
  const { rows } = await db.query<{
    id: string; site_id: string; site: string | null; hazard: string; severity: WeatherAlert["severity"];
    status: WeatherAlert["status"]; title: string; description: string | null; issued_at: Date | null;
    starts_at: Date | null; ends_at: Date | null; acquired_at: Date; source_url: string;
    source_geometry: GeoGeometry | null; source_feature_id: string | null;
  }>(
    `select a.id, a.site_id, o.name site, a.hazard, a.severity, a.status, a.title, a.description,
            a.issued_at, a.starts_at, a.ends_at, a.acquired_at, a.source_url,
            a.source_geometry, a.source_feature_id
       from weather_alerts a
       join objects o on o.tenant_id = a.tenant_id and o.id = a.site_id
      where a.tenant_id = $1 and (a.status = 'resolved') = $2
      order by case a.severity when 'red' then 0 when 'orange' then 1 else 2 end,
               coalesce(a.starts_at, a.issued_at, a.acquired_at) desc
      limit $3`,
    [db.tenantId, !!opts.history, Math.max(1, Math.min(opts.limit ?? 100, 300))],
  );
  return rows.map((r) => ({
    id: Number(r.id), siteId: r.site_id, site: r.site ?? "", hazard: r.hazard, severity: r.severity, status: r.status,
    title: r.title, description: r.description, issuedAt: r.issued_at?.toISOString() ?? null,
    startsAt: r.starts_at?.toISOString() ?? null, endsAt: r.ends_at?.toISOString() ?? null,
    acquiredAt: r.acquired_at.toISOString(), sourceUrl: r.source_url,
    geometry: r.source_geometry, sourceFeatureId: r.source_feature_id,
  }));
}

export async function setWeatherSubscription(
  db: TenantDb, user: { id: string; email?: string }, enabled: boolean,
): Promise<void> {
  if (!user.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) throw new Error("L'account non ha un indirizzo email valido.");
  await db.query(
    `insert into weather_notification_subscriptions (tenant_id, user_id, email, enabled, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (tenant_id, user_id) do update set email = excluded.email, enabled = excluded.enabled, updated_at = now()`,
    [db.tenantId, user.id, user.email, enabled],
  );
  if (enabled) {
    await db.query(
      `update weather_notification_outbox set recipient_email = $3
        where tenant_id = $1 and recipient_user_id = $2 and sent_at is null`,
      [db.tenantId, user.id, user.email],
    );
  } else {
    await db.query(
      `delete from weather_notification_outbox
        where tenant_id = $1 and recipient_user_id = $2 and sent_at is null`,
      [db.tenantId, user.id],
    );
  }
}

export async function getWeatherSubscription(db: TenantDb, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>(
    `select enabled from weather_notification_subscriptions where tenant_id = $1 and user_id = $2`, [db.tenantId, userId],
  );
  return rows[0]?.enabled ?? false;
}

function trustedProviderUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const trusted = host === "api.meteogate.eu" || host === "www.meteoalarm.org" || host.endsWith(".digitaloceanspaces.com");
    if (url.protocol !== "https:" || !trusted || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function asGeometry(value: unknown): GeoGeometry | null {
  const geo = object(value);
  if (!geo || (geo.type !== "Polygon" && geo.type !== "MultiPolygon") || !Array.isArray(geo.coordinates)) return null;
  const coords = geo.coordinates as unknown[];
  let vertices = 0;
  const isPosition = (p: unknown) => Array.isArray(p) && p.length >= 2 &&
    typeof p[0] === "number" && Number.isFinite(p[0]) && p[0] >= -180 && p[0] <= 180 &&
    typeof p[1] === "number" && Number.isFinite(p[1]) && p[1] >= -90 && p[1] <= 90;
  const isRing = (ring: unknown) => {
    if (!Array.isArray(ring) || ring.length < 4 || vertices + ring.length > 50_000 || !ring.every(isPosition)) return false;
    vertices += ring.length;
    return true;
  };
  if (geo.type === "Polygon" && coords.every(isRing)) return geo as GeoGeometry;
  if (geo.type === "MultiPolygon" && coords.every((polygon) => Array.isArray(polygon) && polygon.every(isRing))) return geo as GeoGeometry;
  return null;
}

type PointRelation = "inside" | "outside" | "boundary";

function pointInRing(lon: number, lat: number, ring: number[][]): PointRelation {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const cross = (lon - xi) * (yj - yi) - (lat - yi) * (xj - xi);
    const epsilon = 1e-10;
    if (Math.abs(cross) <= epsilon * Math.max(1, Math.abs(xj - xi), Math.abs(yj - yi)) &&
        lon >= Math.min(xi, xj) - epsilon && lon <= Math.max(xi, xj) + epsilon &&
        lat >= Math.min(yi, yj) - epsilon && lat <= Math.max(yi, yj) + epsilon) {
      return "boundary";
    }
    const crosses = (yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside ? "inside" : "outside";
}

function pointInPolygon(lon: number, lat: number, rings: number[][][]): boolean {
  if (!rings.length) return false;
  const outer = pointInRing(lon, lat, rings[0]);
  if (outer === "outside") return false;
  for (const hole of rings.slice(1)) {
    const relation = pointInRing(lon, lat, hole);
    // Boundaries are included, matching the spatial covers rule used for warning areas.
    if (relation === "boundary") return true;
    if (relation === "inside") return false;
  }
  return true;
}

function geometryContains(geometry: GeoGeometry, lon: number, lat: number): boolean {
  return geometry.type === "Polygon"
    ? pointInPolygon(lon, lat, geometry.coordinates)
    : geometry.coordinates.some((polygon) => pointInPolygon(lon, lat, polygon));
}

function featureLinks(feature: RawFeature) {
  return Array.isArray(feature.links) ? feature.links : [];
}

function parseLanguage(info: CapInfo[]): CapInfo | null {
  return info.find((i) => validString(i.language)?.toLowerCase().startsWith("it")) ?? info[0] ?? null;
}

function severityFromCap(info: CapInfo): "yellow" | "orange" | "red" | null {
  const parameters = values(info.parameter).map(object).filter(Boolean);
  const awareness = parameters.find((p) => {
    const key = validString(p?.valueName)?.toLowerCase();
    return key === "awareness_level" || key === "awarenesslevel";
  });
  const level = validString(awareness?.value)?.toLowerCase();
  if (level === "2" || level === "yellow") return "yellow";
  if (level === "3" || level === "orange") return "orange";
  if (level === "4" || level === "red") return "red";
  const capSeverity = validString(info.severity)?.toLowerCase();
  if (capSeverity === "moderate") return "yellow";
  if (capSeverity === "severe") return "orange";
  if (capSeverity === "extreme") return "red";
  return null;
}

async function fetchJson(url: URL, headers: HeadersInit = {}): Promise<unknown> {
  const response = await fetch(url, { headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  // The MeteoAlarm EDR API uses 204 to signal a valid query with no matching warnings.
  if (response.status === 204) return undefined;
  if (!response.ok) throw new Error(`MeteoGate HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 5_000_000) throw new Error("MeteoGate response exceeds 5 MB");
  const raw = await response.text();
  if (raw.length > 5_000_000) throw new Error("MeteoGate response exceeds 5 MB");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("MeteoGate returned invalid JSON");
  }
}

function requestHeaders(): HeadersInit {
  const key = process.env.METEOGATE_API_KEY?.trim();
  return { accept: "application/geo+json, application/json", ...(key ? { apikey: key } : {}) };
}

async function fetchCountryFeatures(country: string, now: Date): Promise<RawFeature[]> {
  // Keep the request just under the API's 24-hour query window while retaining older active alerts.
  const from = new Date(now.getTime() - (24 * 60 - 1) * 60 * 1000);
  const activeUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const url = new URL(`${METEOGATE_WARNINGS}/${encodeURIComponent(country)}`);
  url.searchParams.set("datetime", `${from.toISOString()}/${now.toISOString()}`);
  url.searchParams.set("active", `${now.toISOString()}/${activeUntil.toISOString()}`);
  url.searchParams.set("language", "it");
  url.searchParams.set("f", "GeoJSON");
  url.searchParams.set("page", "1");

  const firstResult = await fetchJson(url, requestHeaders());
  if (firstResult === undefined) return [];
  const first = object(firstResult);
  if (!first || first.type !== "FeatureCollection" || !Array.isArray(first.features)) {
    throw new Error(`MeteoGate returned an invalid warning collection for ${country}`);
  }
  const metadata = object(first.metadata);
  const pages = Math.max(1, Math.min(20, Math.trunc(Number(metadata?.total_pages) || 1)));
  if (Number(metadata?.total_pages) > pages) throw new Error(`MeteoGate warning pagination exceeds 20 pages for ${country}`);
  const features = [...first.features as RawFeature[]];
  for (let page = 2; page <= pages; page++) {
    url.searchParams.set("page", String(page));
    const pageResult = await fetchJson(url, requestHeaders());
    if (pageResult === undefined) throw new Error(`MeteoGate returned an empty warning page ${page} for ${country}`);
    const body = object(pageResult);
    if (!body || body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
      throw new Error(`MeteoGate returned an invalid warning page for ${country}`);
    }
    features.push(...body.features as RawFeature[]);
  }
  return features;
}

async function fetchCapAlert(feature: RawFeature): Promise<{ root: Record<string, unknown>; infos: CapInfo[] }> {
  const link = featureLinks(feature).find((item) => item.rel === "json" && item.type?.includes("json"));
  const url = trustedProviderUrl(link?.href);
  if (!url) throw new Error("MeteoGate warning is missing a trusted CAP JSON link");
  const cap = object(await fetchJson(url));
  if (!cap) throw new Error("MeteoGate returned an invalid CAP message");
  const root = object(cap.alert) ?? cap;
  const infos = values(root.info).map(object).filter(Boolean) as CapInfo[];
  if (!infos.length) throw new Error("CAP message has no information block");
  return { root, infos };
}

async function fetchExactGeometry(feature: RawFeature): Promise<GeoGeometry> {
  const inline = asGeometry(feature.geometry);
  const links = featureLinks(feature);
  const geometryLink = links.find((item) => item.rel === "geometry" && item.type?.includes("geo+json"));
  // MeteoAlarm documents that its inline geometry can be only a bounding box. When it marks
  // that explicitly, use the linked official geometry so an adjacent area isn't misassigned.
  const bboxOnly = object(feature.properties)?.geometryType === "bbox";
  if (!bboxOnly && inline) return inline;
  const url = trustedProviderUrl(geometryLink?.href);
  if (!url) throw new Error("MeteoGate warning has no trusted exact-geometry link");
  const body = object(await fetchJson(url));
  const geometry = asGeometry(body?.geometry ?? body);
  if (!geometry) throw new Error("MeteoGate returned an invalid warning geometry");
  return geometry;
}

function capInfoKey(info: CapInfo) {
  return validString(info.event)?.toLocaleLowerCase("en") ?? "weather";
}

function activeInfo(info: CapInfo, now: Date): ParsedWarning["severity"] | null {
  const severity = severityFromCap(info);
  if (!severity) return null;
  const onset = validDate(info.onset) ?? validDate(info.effective);
  const expires = validDate(info.expires);
  if (expires && Date.parse(expires) <= now.getTime()) return null;
  if (onset && Date.parse(onset) > now.getTime() + 24 * 60 * 60 * 1000) return null;
  return severity;
}

function warningInWindow(warning: ParsedWarning, now: Date): boolean {
  if (warning.endsAt && Date.parse(warning.endsAt) <= now.getTime()) return false;
  if (warning.startsAt && Date.parse(warning.startsAt) > now.getTime() + 24 * 60 * 60 * 1000) return false;
  return true;
}

async function parseWarnings(features: RawFeature[], now: Date): Promise<ParsedWarning[]> {
  const byArea = new Map<string, RawFeature>();
  for (const feature of features) {
    const props = object(feature.properties);
    if (!props || props.supersededByAlertId || props.supersededAt) continue;
    const alertId = validString(props.alertId);
    const areaId = validString(props.OBJECTID) ?? validString(feature.id);
    if (!alertId || !areaId) continue;
    const key = `${alertId}/${areaId}`;
    const previous = byArea.get(key);
    if (!previous || validString(props.hubLanguage)?.toLowerCase().startsWith("it")) byArea.set(key, feature);
  }

  const capCache = new Map<string, Promise<{ root: Record<string, unknown>; infos: CapInfo[] }>>();
  const geometryCache = new Map<string, Promise<GeoGeometry>>();
  const alerts: ParsedWarning[] = [];

  async function parseFeature(feature: RawFeature) {
    const props = object(feature.properties)!;
    const alertId = validString(props.alertId)!;
    const areaId = validString(props.OBJECTID) ?? validString(feature.id)!;
    const featureId = `${alertId}:${areaId}`;
    let cap = capCache.get(alertId);
    if (!cap) {
      cap = fetchCapAlert(feature);
      capCache.set(alertId, cap);
    }
    const geometryKey = `${alertId}/${areaId}`;
    let geometry = geometryCache.get(geometryKey);
    if (!geometry) {
      geometry = fetchExactGeometry(feature);
      geometryCache.set(geometryKey, geometry);
    }
    const [message, sourceGeometry] = await Promise.all([cap, geometry]);
    const msgType = validString(message.root.msgType)?.toLowerCase();
    const status = validString(message.root.status)?.toLowerCase();
    if ((msgType !== "alert" && msgType !== "update") || status !== "actual") return;
    const selected = parseLanguage(message.infos);
    if (!selected) return;
    const issueTime = validDate(message.root.sent) ?? validDate(props.hubTime);
    for (const info of [selected]) {
      const severity = activeInfo(info, now);
      const event = validString(info.event) ?? "Allerta meteo";
      if (!severity) continue;
      const headline = validString(info.headline) ?? event;
      const start = validDate(info.onset) ?? validDate(info.effective);
      const end = validDate(info.expires);
      alerts.push({
        externalId: `${featureId}:${capInfoKey(info)}`,
        featureId,
        hazard: event,
        severity,
        title: headline,
        description: validString(info.description),
        issuedAt: issueTime,
        startsAt: start,
        endsAt: end,
        sourceGeometry,
        sourceData: {
          provider: "MeteoAlarm via MeteoGate",
          countryCode: props.countryCode ?? null,
          alertId,
          featureId: validString(props.OBJECTID) ?? validString(feature.id),
          msgType: message.root.msgType ?? null,
          status: message.root.status ?? null,
          language: selected.language ?? null,
          awarenessLevel: info.parameter ?? null,
          sourceMetadata: {
            hubLanguage: props.hubLanguage ?? null,
            hubTime: props.hubTime ?? null,
            featureType: props.featureType ?? null,
            indexArea: props.indexArea ?? null,
            indexFeature: props.indexFeature ?? null,
            supersedeType: props.supersedeType ?? null,
          },
          capInfo: info,
        },
      });
    }
  }

  const featuresToParse = [...byArea.values()];
  let nextFeature = 0;
  const workers = Array.from({ length: Math.min(4, featuresToParse.length) }, async () => {
    while (nextFeature < featuresToParse.length) {
      const feature = featuresToParse[nextFeature++];
      await parseFeature(feature);
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return alerts;
}

type SyncStats = { countries: number; locations: number; alerts: number; failedCountries: number; durationMs: number };

async function updateCountryFailure(pool: Pool, country: string, message: string, tenantId?: string) {
  await pool.query(
    `update weather_locations set last_checked_at = now(), last_error = $2
      where enabled and country_code = $1 and ($3::uuid is null or tenant_id = $3)`,
    [country, message.slice(0, 1000), tenantId ?? null],
  );
}

async function countryWarnings(pool: Pool, country: string, now: Date): Promise<ParsedWarning[]> {
  const cached = await pool.query<{
    fetched_at: Date | null; last_attempt_at: Date | null; last_error: string | null; payload: unknown;
  }>(`select fetched_at, last_attempt_at, last_error, payload from weather_source_cache where country_code = $1`, [country]);
  const row = cached.rows[0];
  const payload = Array.isArray(row?.payload) ? row.payload as ParsedWarning[] : null;
  if (row?.fetched_at && !row.last_error && payload && now.getTime() - row.fetched_at.getTime() < COUNTRY_CACHE_MS) {
    return payload.filter((warning) => warningInWindow(warning, now));
  }
  if (row?.last_error && row.last_attempt_at && now.getTime() - row.last_attempt_at.getTime() < COUNTRY_RETRY_MS) {
    throw new Error(row.last_error);
  }

  try {
    const features = await fetchCountryFeatures(country, now);
    const warnings = await parseWarnings(features, now);
    await pool.query(
      `insert into weather_source_cache (country_code, fetched_at, last_attempt_at, last_error, payload, updated_at)
       values ($1, $2, $2, null, $3, $2)
       on conflict (country_code) do update set fetched_at = excluded.fetched_at,
         last_attempt_at = excluded.last_attempt_at, last_error = null, payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [country, now, JSON.stringify(warnings)],
    );
    return warnings;
  } catch (error) {
    const message = ((error as Error).message || "weather source failed").slice(0, 1000);
    await pool.query(
      `insert into weather_source_cache (country_code, last_attempt_at, last_error, payload)
       values ($1, $2, $3, '[]')
       on conflict (country_code) do update set last_attempt_at = excluded.last_attempt_at,
         last_error = excluded.last_error, updated_at = excluded.last_attempt_at`,
      [country, now, message],
    );
    throw new Error(message);
  }
}

async function recordSiteWarnings(pool: Pool, location: {
  tenant_id: string; site_id: string; site: string; latitude: number; longitude: number;
}, warnings: ParsedWarning[], checkedAt: Date): Promise<number> {
  const activeIds: string[] = [];
  let matched = 0;
  for (const warning of warnings) {
    if (!geometryContains(warning.sourceGeometry, location.longitude, location.latitude)) continue;
    activeIds.push(warning.externalId);
    const { rows } = await pool.query<{
      id: string; title: string; severity: string; hazard: string; ends_at: Date | null; notification_revision: number;
    }>(
      `insert into weather_alerts (
         tenant_id, site_id, source, external_id, source_feature_id, hazard, severity,
         title, description, issued_at, starts_at, ends_at, acquired_at, source_url,
         source_geometry, source_data, last_seen_at
       ) values ($1, $2, 'meteogate_meteoalarm', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $12)
       on conflict (tenant_id, site_id, source, external_id) do update set
         source_feature_id = excluded.source_feature_id, hazard = excluded.hazard,
         severity = excluded.severity, title = excluded.title, description = excluded.description,
         issued_at = excluded.issued_at, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         source_url = excluded.source_url,
         source_geometry = excluded.source_geometry, source_data = excluded.source_data,
         notification_revision = weather_alerts.notification_revision + case
           when weather_alerts.status = 'resolved' then 1
           when (case excluded.severity when 'yellow' then 1 when 'orange' then 2 else 3 end) >
                (case weather_alerts.severity when 'yellow' then 1 when 'orange' then 2 else 3 end) then 1
           else 0 end,
         status = case when weather_alerts.status = 'resolved' then 'open' else weather_alerts.status end,
         resolved_at = null, last_seen_at = excluded.last_seen_at
       returning id, title, severity, hazard, ends_at, notification_revision`,
      [location.tenant_id, location.site_id, warning.externalId, warning.featureId, warning.hazard, warning.severity,
        warning.title, warning.description, warning.issuedAt, warning.startsAt, warning.endsAt, checkedAt,
        METEOALARM_HOME, JSON.stringify(warning.sourceGeometry), JSON.stringify(warning.sourceData)],
    );
    const alert = rows[0];
    matched++;
    if (alert && (warning.severity === "orange" || warning.severity === "red")) {
      await pool.query(
        `insert into weather_notification_outbox (
           tenant_id, alert_id, recipient_user_id, recipient_email, subject, body, notification_revision
         )
         select $1, $2, s.user_id, s.email, $3, $4, $5
           from weather_notification_subscriptions s
          where s.tenant_id = $1 and s.enabled
         on conflict (alert_id, recipient_user_id, notification_revision) do nothing`,
        [location.tenant_id, alert.id, `[VDX Meteo] ${warning.severity.toUpperCase()} · ${location.site}: ${warning.title}`,
          `${location.site}\n${warning.title}\nFenomeno: ${warning.hazard}\nLivello ufficiale: ${warning.severity.toUpperCase()}\n` +
          `${warning.description ?? "Dettagli non forniti nella sintesi del servizio."}\n` +
          `Validità: ${warning.startsAt ?? "non indicata"} – ${warning.endsAt ?? "non indicata"}\n` +
          `Fonte: ${METEOALARM_HOME}`, alert.notification_revision],
      );
    }
  }

  await pool.query(
    `update weather_alerts set status = 'resolved', resolved_at = $3
      where tenant_id = $1 and site_id = $2 and source = 'meteogate_meteoalarm'
        and status <> 'resolved' and not (external_id = any($4::text[]))`,
    [location.tenant_id, location.site_id, checkedAt, activeIds],
  );
  await pool.query(
    `update weather_locations set last_checked_at = $3, last_success_at = $3, last_error = null, updated_at = $3
      where tenant_id = $1 and site_id = $2`,
    [location.tenant_id, location.site_id, checkedAt],
  );
  return matched;
}

/** Polls only countries containing configured sites, stores official alerts, and preserves stale data on errors. */
export async function syncWeatherWarnings(pool: Pool, tenantId?: string): Promise<SyncStats> {
  const started = Date.now();
  const startedAt = new Date();
  await pool.query(`insert into engine_jobs (name) values ('weather') on conflict do nothing`);
  try {
    const locations = await pool.query<{
      tenant_id: string; site_id: string; site: string; address: string; latitude: number; longitude: number; country_code: string;
    }>(
      `select w.tenant_id, w.site_id, coalesce(o.name, w.normalized_address) site, w.address,
              w.latitude, w.longitude, w.country_code
         from weather_locations w
         join objects o on o.tenant_id = w.tenant_id and o.id = w.site_id
        where w.enabled and ($1::uuid is null or w.tenant_id = $1)
        order by w.country_code, w.tenant_id, w.site_id`,
      [tenantId ?? null],
    );
    const countries = [...new Set(locations.rows.map((location) => location.country_code))];
    let alerts = 0;
    let failedCountries = 0;
    const errors: string[] = [];
    for (const country of countries) {
      const countrySites = locations.rows.filter((location) => location.country_code === country);
      try {
        const warnings = await countryWarnings(pool, country, startedAt);
        for (const location of countrySites) alerts += await recordSiteWarnings(pool, location, warnings, new Date());
      } catch (error) {
        failedCountries++;
        const message = (error as Error).message || "weather source failed";
        errors.push(`${country}: ${message}`);
        await updateCountryFailure(pool, country, message, tenantId);
      }
    }
    const durationMs = Date.now() - started;
    const result: SyncStats = { countries: countries.length, locations: locations.rows.length, alerts, failedCountries, durationMs };
    const error = errors.length ? errors.join("; ").slice(0, 2000) : null;
    await pool.query(
      `update engine_jobs set last_run = $1, last_ok = case when $2::text is null then $1 else last_ok end,
         last_error = $2, last_duration_ms = $3, last_result = $4 where name = 'weather'`,
      [startedAt, error, durationMs, JSON.stringify(result)],
    );
    return result;
  } catch (error) {
    const message = ((error as Error).message || "weather sync failed").slice(0, 2000);
    await pool.query(
      `update engine_jobs set last_run = $1, last_error = $2, last_duration_ms = $3
        where name = 'weather'`,
      [startedAt, message, Date.now() - started],
    );
    throw error;
  }
}

/** Sends a bounded batch; failures return to the durable outbox with exponential backoff. */
export async function sendWeatherOutbox(
  pool: Pool, mailer: Mailer | null, from: string, tenantId?: string,
): Promise<{ sent: number; deferred: number }> {
  if (!mailer || !from.trim()) return { sent: 0, deferred: 0 };
  const { rows } = await pool.query<{
    id: string; recipient_email: string; subject: string; body: string; attempts: number;
  }>(
    `with batch as (
       select id from weather_notification_outbox
        where sent_at is null and available_at <= now()
          and (claimed_until is null or claimed_until < now())
          and ($1::uuid is null or tenant_id = $1)
        order by id for update skip locked limit 40
     )
     update weather_notification_outbox o
        set claimed_until = now() + interval '10 minutes', attempts = attempts + 1
       from batch where o.id = batch.id
     returning o.id, o.recipient_email, o.subject, o.body, o.attempts`,
    [tenantId ?? null],
  );
  let sent = 0;
  let deferred = 0;
  for (const row of rows) {
    try {
      await mailer.send({ from, to: [row.recipient_email], subject: row.subject, text: row.body });
      await pool.query(`update weather_notification_outbox set sent_at = now(), claimed_until = null, last_error = null where id = $1`, [row.id]);
      sent++;
    } catch (error) {
      const attempts = Number(row.attempts);
      const waitMinutes = Math.min(24 * 60, 2 ** Math.min(attempts, 10));
      await pool.query(
        `update weather_notification_outbox set claimed_until = null, available_at = now() + make_interval(mins => $2), last_error = $3 where id = $1`,
        [row.id, waitMinutes, ((error as Error).message || "mail delivery failed").slice(0, 1000)],
      );
      deferred++;
    }
  }
  return { sent, deferred };
}

export function siteMapUrl(latitude: number, longitude: number): string {
  const url = new URL(OPENSTREETMAP_SEARCH);
  url.searchParams.set("mlat", latitude.toFixed(6));
  url.searchParams.set("mlon", longitude.toFixed(6));
  url.hash = `map=15/${latitude.toFixed(6)}/${longitude.toFixed(6)}`;
  return url.toString();
}

export const weatherSources = {
  warnings: METEOGATE_ORIGIN,
  officialWarnings: METEOALARM_HOME,
};
