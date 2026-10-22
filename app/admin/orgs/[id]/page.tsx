import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getT, timeAgo, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/packages/types";
import { tenantDb } from "@/lib/engine/db";
import { upsertRules } from "@/lib/engine/rules";
import { listAudit, record } from "@/lib/engine/audit";
import { ActivityList } from "@/components/activity-list";
import { listObjects } from "@/lib/packages/console";
import { createPlace, deletePlace, flattenPlaces, movePlace, placeTree, renamePlace, setObjectPlace, type Place } from "@/lib/engine/places";
import { getPackageDef, PACKAGES, UPCOMING } from "@/lib/packages/ui";
import { parseSettings } from "@/lib/settings";
import { SettingsForm } from "@/components/settings-form";
import { createAdminClient } from "@/lib/supabase/admin";
import { SectionTitle } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { countryCodeForWeatherPoint, geocodeWeatherAddress, listWeatherLocations, siteMapUrl, type WeatherLocation } from "@/lib/engine/weather";

const path = (id: string) => `/admin/orgs/${id}`;
const weatherPrecisionKeys = {
  building: "weatherPrecisionBuilding",
  street: "weatherPrecisionStreet",
  postcode: "weatherPrecisionPostcode",
  locality: "weatherPrecisionLocality",
  region: "weatherPrecisionRegion",
  manual: "weatherPrecisionManual",
} as const;

async function toggleModule(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org"));
  // service role: customers may only touch the "config" column of org_modules
  await createAdminClient()
    .from("org_modules")
    .upsert({ org_id: org, module: String(formData.get("module")), enabled: formData.get("enabled") === "1" });
  await record(tenantDb(org), user, formData.get("enabled") === "1" ? "module.enable" : "module.disable", { subject: String(formData.get("module")) });
  revalidatePath(path(org));
}

async function saveThresholds(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org"));
  const mod = getPackageDef(String(formData.get("module")));
  if (!mod) return;
  const config = parseSettings(mod.settings, formData);
  if (!mod.validate?.({ ...mod.defaults, ...config })) {
    await createAdminClient().from("org_modules").update({ config }).eq("org_id", org).eq("module", mod.id);
    await upsertRules(tenantDb(org), mod.id, mod.rules(config), null);
    await record(tenantDb(org), user, "thresholds.org", { subject: mod.id, data: config });
  }
  revalidatePath(path(org));
}

async function addPlace(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org"));
  const parent = String(formData.get("parent") ?? "");
  const name = String(formData.get("name"));
  const id = await createPlace(tenantDb(org), { kind: parent ? "area" : "site", name, parentId: parent || null });
  await record(tenantDb(org), user, "place.create", { objectId: id, subject: name, data: { parent: parent || null } });
  revalidatePath(path(org));
}

async function updatePlace(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org"));
  const id = String(formData.get("id"));
  const db = tenantDb(org);
  const name = String(formData.get("name")).trim();
  if (name) await renamePlace(db, id, name);
  const parent = String(formData.get("parent") ?? "");
  if (parent) await movePlace(db, id, parent);
  if (name || parent) await record(db, user, "place.update", { objectId: id, subject: name || null, data: { parent: parent || null } });
  revalidatePath(path(org));
}

async function saveSiteWeather(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org") ?? "");
  const id = String(formData.get("site") ?? "");
  const address = String(formData.get("address") ?? "").trim();
  let result: "saved" | "error" = "saved";
  try {
    const db = tenantDb(org);
    const site = await db.query(
      `select o.id from objects o join object_types t on t.id = o.type_id
        where o.tenant_id = $1 and o.id = $2 and t.module = 'core' and t.key = 'site'`,
      [org, id],
    );
    if (!site.rowCount || address.length < 5 || address.length > 300) throw new Error("invalid site or address");
    const previous = await db.query<{ latitude: number; longitude: number; country_code: string }>(
      `select latitude, longitude, country_code from weather_locations where tenant_id = $1 and site_id = $2`,
      [org, id],
    );
    const geocoded = await geocodeWeatherAddress(address);
    const latInput = String(formData.get("latitude") ?? "").trim();
    const lonInput = String(formData.get("longitude") ?? "").trim();
    if (!!latInput !== !!lonInput) throw new Error("both coordinates are required");
    const latitude = latInput ? Number(latInput) : geocoded.latitude;
    const longitude = lonInput ? Number(lonInput) : geocoded.longitude;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180)
      throw new Error("invalid coordinates");
    const precision = latInput ? "manual" : geocoded.precision;
    const countryCode = latInput ? await countryCodeForWeatherPoint(latitude, longitude) : geocoded.countryCode;
    await db.query(
      `insert into weather_locations (
         tenant_id, site_id, address, normalized_address, latitude, longitude, country_code,
         geocode_source, geocode_precision, geocoded_at, enabled, updated_at
       ) values ($1, $2, $3, $4, $5, $6, $7, 'OpenStreetMap Nominatim', $8, now(), true, now())
       on conflict (tenant_id, site_id) do update set address = excluded.address,
         normalized_address = excluded.normalized_address, latitude = excluded.latitude,
         longitude = excluded.longitude, country_code = excluded.country_code,
         geocode_source = excluded.geocode_source, geocode_precision = excluded.geocode_precision,
         geocoded_at = now(), enabled = true, last_error = null, updated_at = now()`,
      [org, id, address, geocoded.normalizedAddress, latitude, longitude, countryCode, precision],
    );
    const priorLocation = previous.rows[0];
    if (priorLocation && (
      Number(priorLocation.latitude) !== latitude || Number(priorLocation.longitude) !== longitude ||
      priorLocation.country_code !== countryCode
    )) {
      await db.query(
        `update weather_alerts set status = 'resolved', resolved_at = now()
          where tenant_id = $1 and site_id = $2 and source = 'meteogate_meteoalarm' and status <> 'resolved'`,
        [org, id],
      );
    }
    await record(db, user, "weather.location.update", {
      objectId: id,
      subject: geocoded.normalizedAddress,
      data: { latitude, longitude, countryCode, precision },
    });
  } catch {
    result = "error";
  }
  revalidatePath(path(org));
  redirect(`${path(org)}?tab=sites&weather=${result}`);
}

async function disableSiteWeather(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org") ?? "");
  const id = String(formData.get("site") ?? "");
  const db = tenantDb(org);
  await db.query(
    `update weather_locations set enabled = false, last_error = null, updated_at = now()
      where tenant_id = $1 and site_id = $2`, [org, id],
  );
  await db.query(
    `update weather_alerts set status = 'resolved', resolved_at = now()
      where tenant_id = $1 and site_id = $2 and status <> 'resolved'`, [org, id],
  );
  await record(db, user, "weather.location.disable", { objectId: id });
  revalidatePath(path(org));
  redirect(`${path(org)}?tab=sites&weather=disabled`);
}

async function removePlace(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org"));
  const id = String(formData.get("id"));
  await deletePlace(tenantDb(org), id);
  await record(tenantDb(org), user, "place.delete", { objectId: id });
  revalidatePath(path(org));
}

async function updateDevice(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org"));
  const id = String(formData.get("id"));
  const db = tenantDb(org);
  await db.query(`update objects set name = $3 where tenant_id = $1 and id = $2`, [org, id, String(formData.get("name")).trim() || null]);
  const place = String(formData.get("place")) || null;
  await setObjectPlace(db, id, place);
  await record(db, user, "object.update", { objectId: id, subject: String(formData.get("name")).trim() || null, data: { place } });
  revalidatePath(path(org));
}

async function addMember(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org") ?? "");
  const admin = createAdminClient();
  const email = String(formData.get("email")).trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!org || !email || password.length < 8) throw new Error("Email and a password of at least 8 characters are required.");
  const { data: list, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) throw new Error(listError.message);
  let userId = list.users.find((u) => u.email?.toLowerCase() === email)?.id;
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    userId = data.user.id;
  } else {
    // The password field is explicitly labeled as temporary: apply it to existing accounts too.
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) throw new Error(error.message);
  }
  const { error: membershipError } = await admin.from("memberships").upsert({ org_id: org, user_id: userId, role: String(formData.get("role")) });
  if (membershipError) throw new Error(membershipError.message);
  await record(tenantDb(org), user, "member.add", { subject: email, data: { role: String(formData.get("role")) } });
  revalidatePath(path(org));
}

async function changeMemberPassword(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org") ?? "");
  const userId = String(formData.get("user") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!org || !userId || password.length < 8) throw new Error("A password of at least 8 characters is required.");
  const admin = createAdminClient();
  const { data: membership, error: membershipError } = await admin.from("memberships").select("user_id").eq("org_id", org).eq("user_id", userId).maybeSingle();
  if (membershipError) throw new Error(membershipError.message);
  if (!membership) throw new Error("User is not a member of this organization.");
  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) throw new Error(error.message);
  await record(tenantDb(org), user, "member.password", { data: { user: userId } });
  revalidatePath(path(org));
}

async function removeMember(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org"));
  // only the membership: the login may belong to other organizations too
  await createAdminClient().from("memberships").delete().eq("org_id", org).eq("user_id", String(formData.get("user")));
  await record(tenantDb(org), user, "member.remove", { data: { user: String(formData.get("user")) } });
  revalidatePath(path(org));
}

const TABS = ["overview", "thresholds", "sites", "members", "activity"] as const;
type Tab = (typeof TABS)[number];

export default async function OrgAdmin(props: PageProps<"/admin/orgs/[id]">) {
  const [{ id }, sp] = await Promise.all([props.params, props.searchParams]);
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : "overview";
  const { supabase } = await requireAdmin();
  const { t, locale } = await getT();
  // only what the open tab shows: the org and its products are cheap, the rest is loaded on demand
  const [{ data: org }, mods] = await Promise.all([
    supabase.from("organizations").select("id, name, slug").eq("id", id).maybeSingle(),
    supabase.from("org_modules").select("module, enabled, config").eq("org_id", id),
  ]);
  if (!org) notFound();
  const enabled = new Map((mods.data ?? []).map((m) => [m.module, m]));
  const configurable = Object.values(PACKAGES).filter((m) => enabled.get(m.id)?.enabled && m.settings.length);
  const tabLabel: Record<Tab, string> = { overview: t.overview, thresholds: t.thresholds, sites: t.places, members: t.members, activity: t.activity };

  return (
    <div>
      <Link href="/admin" className="text-sm text-dim hover:text-frost">
        ← {t.customers}
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
          <div className="num text-xs text-dim">/{org.slug}</div>
        </div>
        <Link href={`/o/${org.slug}`} className="btn">
          {t.openCustomer} →
        </Link>
      </div>

      <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-line-soft text-sm">
        {TABS.filter((k) => k !== "thresholds" || configurable.length).map((k) => (
          <Link
            key={k}
            href={k === "overview" ? path(id) : `${path(id)}?tab=${k}`}
            prefetch
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 ${
              tab === k ? "border-ice text-frost" : "border-transparent text-dim hover:text-mist"
            }`}
          >
            {tabLabel[k]}
          </Link>
        ))}
      </nav>

      {tab === "overview" && <Overview id={id} enabled={enabled} t={t} locale={locale} />}
      {tab === "thresholds" &&
        configurable.map((m) => (
          <div key={m.id}>
            <SectionTitle>
              {m.name} · {t.orgDefaults}
            </SectionTitle>
            <p className="mb-3 text-sm text-mist">{t.orgDefaultsHelp}</p>
            <SettingsForm
              mod={m}
              action={saveThresholds}
              hidden={{ org: id, module: m.id }}
              values={(enabled.get(m.id)?.config ?? {}) as Record<string, number>}
              inherited={m.defaults as Record<string, number>}
              editable
              allowEmpty={false}
              t={t}
              locale={locale}
            />
          </div>
        ))}
      {tab === "sites" && <Sites id={id} t={t} locale={locale} weatherStatus={String(sp.weather ?? "")} />}
      {tab === "members" && <Members id={id} t={t} />}
      {tab === "activity" && <ActivityList entries={await listAudit(tenantDb(id), { limit: 200 })} t={t} locale={locale} />}
    </div>
  );
}

type Ctx = { id: string; t: Dict };

function RemoveButton({ t }: { t: Dict }) {
  return (
    <ConfirmButton message={t.confirmRemove} className="text-xs text-dim hover:text-alarm">
      {t.remove}
    </ConfirmButton>
  );
}

function Overview({
  id,
  enabled,
  t,
  locale,
}: Ctx & { enabled: Map<string, { enabled: boolean }>; locale: Locale }) {
  return (
    <>
      <SectionTitle>{t.modules}</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Object.values(PACKAGES).map((m) => {
          const on = enabled.get(m.id)?.enabled ?? false;
          return (
            <form key={m.id} action={toggleModule} className={`card p-5 ${on ? "border-ice/40" : ""}`}>
              <input type="hidden" name="org" value={id} />
              <input type="hidden" name="module" value={m.id} />
              <input type="hidden" name="enabled" value={on ? "0" : "1"} />
              <div className="flex items-center justify-between">
                <span className="text-lg font-medium">{m.name}</span>
                <button className={`btn text-xs ${on ? "border-ok text-ok" : ""}`}>{on ? t.enabled : t.disabled}</button>
              </div>
              <p className="mt-2 text-sm text-mist">{m.tagline[locale]}</p>
            </form>
          );
        })}
        {UPCOMING.map((m) => (
          <div key={m.id} className="card p-5 opacity-50">
            <div className="flex items-center justify-between">
              <span className="text-lg font-medium">{m.name}</span>
              <span className="text-xs text-dim">{t.comingSoon}</span>
            </div>
            <p className="mt-2 text-sm text-mist">{m.tagline[locale]}</p>
          </div>
        ))}
      </div>
    </>
  );
}

/** One place with its areas below; areas can be renamed, moved under another place, removed. */
function PlaceNode({ id, place, all, t, weatherLocations }: Ctx & {
  place: Place;
  all: { place: Place; path: string[] }[];
  weatherLocations: Map<string, WeatherLocation>;
}) {
  // a place cannot move under itself or its own areas
  const below = new Set(flattenPlaces([place]).map((p) => p.place.id));
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <form action={updatePlace} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <input type="hidden" name="org" value={id} />
          <input type="hidden" name="id" value={place.id} />
          <span className="w-10 text-[11px] uppercase tracking-wider text-dim">{place.kind === "site" ? t.site : t.area}</span>
          <input name="name" defaultValue={place.name} className="min-w-0 flex-1" />
          {place.kind === "area" && (
            <select name="parent" defaultValue={place.parentId ?? ""} className="max-w-48">
              {all
                .filter((p) => !below.has(p.place.id))
                .map((p) => (
                  <option key={p.place.id} value={p.place.id}>
                    {p.path.join(" · ")}
                  </option>
                ))}
            </select>
          )}
          <button className="btn text-xs">{t.save}</button>
        </form>
        <form action={removePlace}>
          <input type="hidden" name="org" value={id} />
          <input type="hidden" name="id" value={place.id} />
          <RemoveButton t={t} />
        </form>
      </div>
      {place.kind === "site" && (
        <SiteWeatherForm id={id} place={place} location={weatherLocations.get(place.id) ?? null} t={t} />
      )}
      <ul className="ml-4 border-l border-line-soft pl-3">
        {place.children.map((c) => (
          <PlaceNode key={c.id} id={id} place={c} all={all} t={t} weatherLocations={weatherLocations} />
        ))}
        <li className="py-1.5">
          <form action={addPlace} className="flex gap-2">
            <input type="hidden" name="org" value={id} />
            <input type="hidden" name="parent" value={place.id} />
            <input name="name" placeholder={t.newArea} required className="min-w-0 flex-1" />
            <button className="btn">+</button>
          </form>
        </li>
      </ul>
    </li>
  );
}

function SiteWeatherForm({ id, place, location, t }: Ctx & { place: Place; location: WeatherLocation | null }) {
  return (
    <div className="ml-10 mt-2 border-l border-line-soft pl-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-dim">{t.weatherLocation}</div>
      {location && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mist">
          <span>{location.normalizedAddress}</span>
          <span className="num text-dim">{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)} · {location.countryCode}</span>
          <span className="text-warn">{t.weatherPrecision}: {t[weatherPrecisionKeys[location.precision]]}</span>
          <a href={siteMapUrl(location.latitude, location.longitude)} target="_blank" rel="noreferrer" className="text-ice hover:underline">
            {t.weatherCheckPin} ↗
          </a>
          <span className={location.enabled ? "text-ok" : "text-warn"}>{location.enabled ? t.enabled : t.disabled}</span>
        </div>
      )}
      <form action={saveSiteWeather} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="org" value={id} />
        <input type="hidden" name="site" value={place.id} />
        <label className="grid min-w-64 flex-1 gap-1 text-xs text-dim">
          <span>{t.address}</span>
          <input name="address" defaultValue={location?.address ?? ""} placeholder={t.weatherAddressPlaceholder} required maxLength={300} />
        </label>
        <label className="grid w-32 gap-1 text-xs text-dim">
          <span>{t.weatherLatitude}</span>
          <input name="latitude" inputMode="decimal"
            defaultValue={location?.precision === "manual" ? location.latitude.toFixed(5) : ""}
            placeholder="auto" />
        </label>
        <label className="grid w-32 gap-1 text-xs text-dim">
          <span>{t.weatherLongitude}</span>
          <input name="longitude" inputMode="decimal"
            defaultValue={location?.precision === "manual" ? location.longitude.toFixed(5) : ""}
            placeholder="auto" />
        </label>
        <button className="btn text-xs">{location ? t.weatherUpdate : t.weatherFindAddress}</button>
      </form>
      {location?.enabled && (
        <form action={disableSiteWeather} className="mt-2">
          <input type="hidden" name="org" value={id} />
          <input type="hidden" name="site" value={place.id} />
          <button className="btn text-xs text-warn">{t.weatherDisable}</button>
        </form>
      )}
      <p className="mt-1 text-xs text-dim">{t.weatherAddressHelp} {t.weatherPrecisionHelp}</p>
    </div>
  );
}

async function Sites({ id, t, locale, weatherStatus }: Ctx & { locale: Locale; weatherStatus?: string }) {
  const db = tenantDb(id);
  const [tree, devices, weatherList] = await Promise.all([
    placeTree(db),
    Promise.all(Object.keys(PACKAGES).map((m) => listObjects(db, m))).then((l) => l.flat()),
    listWeatherLocations(db),
  ]);
  const all = flattenPlaces(tree);
  const weatherLocations = new Map(weatherList.map((location) => [location.siteId, location]));

  return (
    <>
      <SectionTitle>{t.places}</SectionTitle>
      {weatherStatus && (
        <p className={`mb-3 text-sm ${weatherStatus === "error" ? "text-alarm" : "text-ok"}`}>
          {weatherStatus === "error" ? t.weatherAddressError : weatherStatus === "disabled" ? t.weatherDisabled : t.weatherAddressSaved}
        </p>
      )}
      <div className="card p-5">
        {!tree.length && <p className="text-sm text-dim">{t.noSites}</p>}
        <ul className="divide-y divide-line-soft text-sm">
          {tree.map((p) => <PlaceNode key={p.id} id={id} place={p} all={all} t={t} weatherLocations={weatherLocations} />)}
        </ul>
        <form action={addPlace} className="mt-3 flex gap-2">
          <input type="hidden" name="org" value={id} />
          <input name="name" placeholder={t.newSite} required className="min-w-0 flex-1" />
          <button className="btn">+</button>
        </form>
      </div>

      {!!devices.length && (
        <>
          <SectionTitle
            right={
              <Link href="/admin/engine" className="text-xs text-dim hover:text-frost">
                {t.sources} →
              </Link>
            }
          >
            {t.devices}
          </SectionTitle>
          <div className="card divide-y divide-line-soft">
            {devices.map((d) => (
              <form key={d.id} action={updateDevice} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <input type="hidden" name="org" value={id} />
                <input type="hidden" name="id" value={d.id} />
                <span className="w-20 capitalize text-mist">{d.type}</span>
                <span className="num w-24 truncate text-dim">#{d.externalId}</span>
                <input name="name" defaultValue={d.name} className="w-40" />
                <select name="place" defaultValue={d.placeId ?? ""} className="max-w-56">
                  <option value="">{t.unassigned}</option>
                  {all.map((p) => (
                    <option key={p.place.id} value={p.place.id}>
                      {p.path.join(" · ")}
                    </option>
                  ))}
                </select>
                <span className="flex-1 text-xs text-dim">
                  {t.lastSeen}: {timeAgo(d.lastSeen, locale, t)}
                </span>
                <button className="btn text-xs">{t.save}</button>
              </form>
            ))}
          </div>
        </>
      )}
    </>
  );
}

async function Members({ id, t }: Ctx) {
  const admin = createAdminClient();
  const { data: members, error } = await admin.from("memberships").select("user_id, role").eq("org_id", id);
  if (error) throw new Error(error.message);
  // one lookup per member instead of listing every user of the platform
  const users = await Promise.all((members ?? []).map((m) => admin.auth.admin.getUserById(m.user_id)));

  return (
    <>
      <SectionTitle>{t.members}</SectionTitle>
      <div className="card divide-y divide-line-soft">
        {(members ?? []).map((m, i) => (
          <div key={m.user_id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
            <span className="truncate">{users[i].data.user?.email ?? m.user_id}</span>
            <span className="flex items-center gap-4">
              <span className="text-dim">{t[`role_${m.role as "owner" | "member" | "viewer"}`]}</span>
              <form action={changeMemberPassword} className="flex items-center gap-2">
                <input type="hidden" name="org" value={id} />
                <input type="hidden" name="user" value={m.user_id} />
                <input name="password" type="password" placeholder={t.newPassword} minLength={8} required autoComplete="new-password" className="h-8 w-40 text-xs" />
                <button className="btn text-xs">{t.changePassword}</button>
              </form>
              <form action={removeMember}>
                <input type="hidden" name="org" value={id} />
                <input type="hidden" name="user" value={m.user_id} />
                <RemoveButton t={t} />
              </form>
            </span>
          </div>
        ))}
        <form action={addMember} className="flex flex-wrap gap-2 px-5 py-4">
          <input type="hidden" name="org" value={id} />
          <input name="email" type="email" placeholder={t.email} required className="min-w-0 flex-1" />
          <input name="password" placeholder={t.tempPassword} minLength={8} required className="min-w-0 flex-1" />
          <select name="role" defaultValue="member">
            {(["owner", "member", "viewer"] as const).map((r) => (
              <option key={r} value={r}>
                {t[`role_${r}`]}
              </option>
            ))}
          </select>
          <button className="btn">{t.addMember}</button>
        </form>
      </div>
    </>
  );
}
