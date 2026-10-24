import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getT, timeAgo, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/packages/types";
import { tenantDb } from "@/lib/engine/db";
import { upsertRules } from "@/lib/engine/rules";
import { revokeTokens } from "@/lib/engine/sources";
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

const path = (id: string) => `/admin/orgs/${id}`;

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

/** Deletes one push token, or all of the organization's when no source id is sent. */
async function deleteTokens(formData: FormData) {
  "use server";
  const { user } = await requireAdmin();
  const org = String(formData.get("org"));
  const source = String(formData.get("id") ?? "") || undefined;
  const n = await revokeTokens(tenantDb(org), org, source);
  if (n) await record(tenantDb(org), user, "token.delete", { objectId: source ?? null, subject: String(formData.get("name") ?? "") || null, data: { count: n } });
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
        <Link href={`/terra/o/${org.slug}`} className="btn">
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
      {tab === "sites" && <Sites id={id} t={t} locale={locale} />}
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
      <Tokens id={id} t={t} locale={locale} />
      <NodeSensors id={id} t={t} locale={locale} />
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

/** The organization's push tokens (one per gateway source): delete one, or all of them at once. */
async function Tokens({ id, t, locale }: Ctx & { locale: Locale }) {
  const { rows } = await tenantDb(id).query<{ id: string; name: string; module: string; token_hint: string | null; last_seen: Date | null }>(
    `select id, name, module, token_hint, last_seen from sources where tenant_id = $1 and connector = 'push' order by name`,
    [id],
  );
  if (!rows.length) return null;
  const live = rows.filter((r) => r.token_hint).length;
  return (
    <>
      <SectionTitle
        right={
          live > 0 && (
            <form action={deleteTokens}>
              <input type="hidden" name="org" value={id} />
              <ConfirmButton message={t.deleteAllTokensConfirm} className="btn text-xs text-alarm">
                {t.deleteAllTokens} ({live})
              </ConfirmButton>
            </form>
          )
        }
      >
        {t.tokens}
      </SectionTitle>
      <div className="card divide-y divide-line-soft">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
            <span className="num text-xs text-dim">{r.module}</span>
            <span className="num w-28 text-xs text-dim">{timeAgo(r.last_seen?.toISOString() ?? null, locale, t)}</span>
            {r.token_hint ? (
              <>
                <span className="num w-16 text-mist">…{r.token_hint}</span>
                <form action={deleteTokens}>
                  <input type="hidden" name="org" value={id} />
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="name" value={r.name} />
                  <ConfirmButton message={t.deleteTokenConfirm} className="btn text-xs text-alarm">
                    {t.deleteToken}
                  </ConfirmButton>
                </form>
              </>
            ) : (
              <span className="text-xs text-warn">{t.noToken}</span>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-dim">{t.tokensHelp}</p>
    </>
  );
}

const SENSOR_NAMES: Record<string, string> = { bh1750: "Luce BH1750", ldr: "Fotoresistenza", mlx90614: "IR MLX90614" };
/** Firmware before 1.2.0 does not report its sensors: a reading in the last day means the sensor is there. */
const INFERRED: Record<string, string> = { lux: "Luce", leaf_c: "IR" };

/** Which sensors each Heltec node finds at every push: green detected, red missing. */
async function NodeSensors({ id, t, locale }: Ctx & { locale: Locale }) {
  const nodes = await listObjects(tenantDb(id), "lora");
  if (!nodes.length) return null;
  const badge = (label: string, ok: boolean | null) => (
    <span
      key={label}
      className={`rounded border px-2 py-0.5 text-xs ${ok === null ? "text-dim" : ok ? "border-ok/50 text-ok" : "border-alarm/50 text-alarm"}`}
    >
      {label}: {ok === null ? t.sensorNoData : ok ? t.sensorDetected : t.sensorMissing}
    </span>
  );
  return (
    <>
      <SectionTitle>{t.nodeSensors}</SectionTitle>
      <div className="card divide-y divide-line-soft">
        {nodes.map((n) => {
          const device = (n.properties?.device ?? {}) as { fw?: string | null; rssi?: number | null; sensors?: Record<string, boolean> | null };
          const sensors = device.sensors ? Object.entries(device.sensors) : null;
          return (
            <div key={n.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">
                {n.name} <span className="num text-xs text-dim">#{n.externalId}</span>
              </span>
              <span className="num w-16 text-xs text-dim">{device.fw ? `v${device.fw}` : "—"}</span>
              <span className="num w-20 text-xs text-dim">{device.rssi != null ? `${device.rssi} dBm` : ""}</span>
              <span className="flex flex-wrap gap-2">
                {sensors
                  ? sensors.map(([k, ok]) => badge(SENSOR_NAMES[k] ?? k, ok))
                  : Object.entries(INFERRED).map(([k, label]) => badge(label, k in n.values ? true : null))}
              </span>
              <span className="num w-28 text-xs text-dim">{timeAgo(n.lastSeen, locale, t)}</span>
              {!sensors && <span className="w-full text-xs text-warn">{t.sensorInferred}</span>}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-dim">{t.nodeSensorsHelp}</p>
    </>
  );
}

/** One place with its areas below; areas can be renamed, moved under another place, removed. */
function PlaceNode({ id, place, all, t }: Ctx & {
  place: Place;
  all: { place: Place; path: string[] }[];
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
      <ul className="ml-4 border-l border-line-soft pl-3">
        {place.children.map((c) => (
          <PlaceNode key={c.id} id={id} place={c} all={all} t={t} />
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

async function Sites({ id, t, locale }: Ctx & { locale: Locale }) {
  const db = tenantDb(id);
  const [tree, devices] = await Promise.all([
    placeTree(db),
    Promise.all(Object.keys(PACKAGES).map((m) => listObjects(db, m))).then((l) => l.flat()),
  ]);
  const all = flattenPlaces(tree);

  return (
    <>
      <SectionTitle>{t.places}</SectionTitle>
      <div className="card p-5">
        {!tree.length && <p className="text-sm text-dim">{t.noSites}</p>}
        <ul className="divide-y divide-line-soft text-sm">
          {tree.map((p) => <PlaceNode key={p.id} id={id} place={p} all={all} t={t} />)}
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
