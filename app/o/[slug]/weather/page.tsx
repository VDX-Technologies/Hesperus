import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/auth";
import { getT, type Dict } from "@/lib/i18n";
import { crossTenantAccess, crossTenantDb, tenantDb } from "@/lib/engine/db";
import { record } from "@/lib/engine/audit";
import { getSettings } from "@/lib/engine/settings";
import { mailerFromEnv } from "@/lib/engine/mail";
import {
  getWeatherSubscription,
  listWeatherAlerts,
  listWeatherLocations,
  sendWeatherOutbox,
  setWeatherSubscription,
  syncWeatherWarnings,
} from "@/lib/engine/weather";
import { WeatherCenter } from "@/components/weather-center";
import { weatherTileSettings } from "@/lib/weather-tiles";

const route = (slug: string) => `/o/${slug}/weather`;

async function subscriptionAction(formData: FormData) {
  "use server";
  const slug = String(formData.get("slug") ?? "");
  const ctx = await requireOrg(slug);
  const enabled = String(formData.get("enabled")) === "1";
  await setWeatherSubscription(tenantDb(ctx.org.id), ctx.user, enabled);
  await record(tenantDb(ctx.org.id), ctx.user, "weather.notification.update", { data: { enabled } });
  revalidatePath(route(slug));
}

async function acknowledgeAction(formData: FormData) {
  "use server";
  const slug = String(formData.get("slug") ?? "");
  const ctx = await requireOrg(slug);
  if (ctx.role === "viewer") throw new Error("Only members can acknowledge weather alerts.");
  const id = Number(formData.get("id"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid weather alert id.");
  const db = tenantDb(ctx.org.id);
  const { rows } = await db.query<{ site_id: string; title: string }>(
    `update weather_alerts set status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $3
      where tenant_id = $1 and id = $2 and status = 'open'
      returning site_id, title`,
    [ctx.org.id, id, ctx.user.id],
  );
  if (rows[0]) await record(db, ctx.user, "weather.alert.ack", { objectId: rows[0].site_id, subject: rows[0].title, data: { alertId: id } });
  revalidatePath(route(slug));
}

async function refreshAction(formData: FormData) {
  "use server";
  const slug = String(formData.get("slug") ?? "");
  const ctx = await requireOrg(slug);
  if (ctx.role === "viewer") throw new Error("Only members can refresh weather data.");
  const pool = crossTenantDb(crossTenantAccess.maintenance);
  await syncWeatherWarnings(pool, ctx.org.id);
  const settings = await getSettings(crossTenantDb(crossTenantAccess.settings), true);
  await sendWeatherOutbox(pool, mailerFromEnv(), String(settings["alerts.email_from"] ?? ""), ctx.org.id);
  revalidatePath(route(slug));
}

export default async function WeatherPage(props: PageProps<"/o/[slug]/weather">) {
  const { slug } = await props.params;
  const ctx = await requireOrg(slug);
  const { t, locale } = await getT();
  const db = tenantDb(ctx.org.id);
  const [sites, alerts, history, subscriptionEnabled] = await Promise.all([
    listWeatherLocations(db),
    listWeatherAlerts(db, { limit: 150 }),
    listWeatherAlerts(db, { history: true, limit: 100 }),
    getWeatherSubscription(db, ctx.user.id),
  ]);

  const labels = Object.fromEntries([
    "weatherConsole", "weatherSubtitle", "weatherOfficial", "weatherMap", "weatherMapAttribution",
    "weatherLayerSites", "weatherLayerAlerts", "weatherNoLocations", "weatherNoAlerts", "weatherOpenAlerts",
    "weatherHistory", "weatherSitesMonitored", "weatherSitesWithWarnings", "weatherLastUpdate", "weatherStale",
    "weatherNeverUpdated", "weatherSourceError", "weatherHazard", "weatherValidFrom", "weatherValidUntil",
    "weatherSourceName", "weatherAcknowledge", "weatherAcknowledged", "weatherRefresh", "weatherNotify",
    "weatherNotifyOn", "weatherNotifyOff", "weatherNotifyHelp", "weatherNoSiteAddress", "weatherPrecision", "weatherPrecisionHelp",
    "weatherPrecisionBuilding", "weatherPrecisionStreet", "weatherPrecisionPostcode", "weatherPrecisionLocality", "weatherPrecisionRegion", "weatherPrecisionManual",
    "weatherLicense", "weatherCheckPin", "site", "sites",
  ].map((key) => [key, t[key as keyof Dict]])) as Record<string, string>;

  return (
    <WeatherCenter
      slug={slug}
      sites={sites}
      alerts={alerts}
      history={history}
      subscriptionEnabled={subscriptionEnabled}
      canAcknowledge={ctx.role !== "viewer"}
      canRefresh={ctx.role !== "viewer"}
      locale={locale}
      labels={labels}
      tileSettings={weatherTileSettings()}
      refreshAction={refreshAction}
      subscriptionAction={subscriptionAction}
      acknowledgeAction={acknowledgeAction}
    />
  );
}
