import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getT, timeAgo, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/packages/types";
import { getPool } from "@/lib/engine/db";
import { upsertRules } from "@/lib/engine/rules";
import { listObjects } from "@/lib/packages/console";
import { getPackageDef, PACKAGES, UPCOMING } from "@/lib/packages/ui";
import { parseSettings } from "@/lib/settings";
import { SettingsForm } from "@/components/settings-form";
import { createAdminClient } from "@/lib/supabase/admin";
import { SectionTitle } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";

const path = (id: string) => `/admin/orgs/${id}`;

async function toggleModule(formData: FormData) {
  "use server";
  await requireAdmin();
  const org = String(formData.get("org"));
  // service role: customers may only touch the "config" column of org_modules
  await createAdminClient()
    .from("org_modules")
    .upsert({ org_id: org, module: String(formData.get("module")), enabled: formData.get("enabled") === "1" });
  revalidatePath(path(org));
}

async function saveThresholds(formData: FormData) {
  "use server";
  await requireAdmin();
  const org = String(formData.get("org"));
  const mod = getPackageDef(String(formData.get("module")));
  if (!mod) return;
  const config = parseSettings(mod.settings, formData);
  if (!mod.validate?.({ ...mod.defaults, ...config })) {
    await createAdminClient().from("org_modules").update({ config }).eq("org_id", org).eq("module", mod.id);
    await upsertRules(getPool(), org, mod.id, mod.rules(config), null);
  }
  revalidatePath(path(org));
}

async function addSite(formData: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  const org = String(formData.get("org"));
  await supabase.from("sites").insert({ org_id: org, name: String(formData.get("name")) });
  revalidatePath(path(org));
}

async function addZone(formData: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  const org = String(formData.get("org"));
  await supabase.from("zones").insert({ org_id: org, site_id: String(formData.get("site")), name: String(formData.get("name")) });
  revalidatePath(path(org));
}

async function updateDevice(formData: FormData) {
  "use server";
  await requireAdmin();
  const org = String(formData.get("org"));
  const zone = String(formData.get("zone"));
  await getPool().query(
    `update objects set name = $3,
       properties = case when $4::text is null then properties - 'zone_id' else properties || jsonb_build_object('zone_id', $4::text) end
     where tenant_id = $1 and id = $2`,
    [org, String(formData.get("id")), String(formData.get("name")).trim() || null, zone || null],
  );
  revalidatePath(path(org));
}

async function addMember(formData: FormData) {
  "use server";
  await requireAdmin();
  const org = String(formData.get("org"));
  const admin = createAdminClient();
  const email = String(formData.get("email")).trim().toLowerCase();
  const { data: list } = await admin.auth.admin.listUsers();
  let userId = list?.users.find((u) => u.email === email)?.id;
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: String(formData.get("password")),
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    userId = data.user.id;
  }
  await admin.from("memberships").upsert({ org_id: org, user_id: userId, role: String(formData.get("role")) });
  revalidatePath(path(org));
}

async function removeSite(formData: FormData) {
  "use server";
  await requireAdmin();
  const org = String(formData.get("org"));
  const site = String(formData.get("id"));
  const admin = createAdminClient();
  const { data: zones } = await admin.from("zones").select("id").eq("org_id", org).eq("site_id", site);
  await unassignZones(org, (zones ?? []).map((z) => z.id));
  // zones go with the site (on delete cascade)
  await admin.from("sites").delete().eq("org_id", org).eq("id", site);
  revalidatePath(path(org));
}

async function removeZone(formData: FormData) {
  "use server";
  await requireAdmin();
  const org = String(formData.get("org"));
  const zone = String(formData.get("id"));
  await unassignZones(org, [zone]);
  await createAdminClient().from("zones").delete().eq("org_id", org).eq("id", zone);
  revalidatePath(path(org));
}

/** Engine objects keep zone_id in their properties: no FK, so clear it by hand. */
async function unassignZones(org: string, zones: string[]) {
  if (!zones.length) return;
  await getPool().query(
    `update objects set properties = properties - 'zone_id' where tenant_id = $1 and properties->>'zone_id' = any($2)`,
    [org, zones],
  );
}

async function removeMember(formData: FormData) {
  "use server";
  await requireAdmin();
  const org = String(formData.get("org"));
  // only the membership: the login may belong to other organizations too
  await createAdminClient().from("memberships").delete().eq("org_id", org).eq("user_id", String(formData.get("user")));
  revalidatePath(path(org));
}

const TABS = ["overview", "thresholds", "sites", "members"] as const;
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
  const tabLabel: Record<Tab, string> = { overview: t.overview, thresholds: t.thresholds, sites: t.sitesZones, members: t.members };

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
      {tab === "sites" && <Sites id={id} t={t} locale={locale} />}
      {tab === "members" && <Members id={id} t={t} />}
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

async function Sites({ id, t, locale }: Ctx & { locale: Locale }) {
  const supabase = createAdminClient();
  const [sites, zones, devices] = await Promise.all([
    supabase.from("sites").select("id, name").eq("org_id", id).order("name"),
    supabase.from("zones").select("id, name, site_id").eq("org_id", id).order("name"),
    Promise.all(Object.keys(PACKAGES).map((m) => listObjects(getPool(), id, m))).then((l) => l.flat()),
  ]);
  const siteName = new Map((sites.data ?? []).map((s) => [s.id, s.name]));

  return (
    <>
      <SectionTitle>{t.sitesZones}</SectionTitle>
      <div className="grid gap-3 md:grid-cols-2">
        {(sites.data ?? []).map((s) => (
          <div key={s.id} className="card p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{s.name}</span>
              <form action={removeSite}>
                <input type="hidden" name="org" value={id} />
                <input type="hidden" name="id" value={s.id} />
                <RemoveButton t={t} />
              </form>
            </div>
            <ul className="mt-3 divide-y divide-line-soft text-sm">
              {(zones.data ?? [])
                .filter((z) => z.site_id === s.id)
                .map((z) => (
                  <li key={z.id} className="flex items-center justify-between py-1.5">
                    <span className="text-mist">{z.name}</span>
                    <form action={removeZone}>
                      <input type="hidden" name="org" value={id} />
                      <input type="hidden" name="id" value={z.id} />
                      <RemoveButton t={t} />
                    </form>
                  </li>
                ))}
            </ul>
            <form action={addZone} className="mt-3 flex gap-2">
              <input type="hidden" name="org" value={id} />
              <input type="hidden" name="site" value={s.id} />
              <input name="name" placeholder={t.newZone} required className="min-w-0 flex-1" />
              <button className="btn">+</button>
            </form>
          </div>
        ))}
        <form action={addSite} className="card flex items-start gap-2 border-dashed p-5">
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
                <select name="zone" defaultValue={d.zoneId ?? ""}>
                  <option value="">{t.unassigned}</option>
                  {(zones.data ?? []).map((z) => (
                    <option key={z.id} value={z.id}>
                      {siteName.get(z.site_id)} · {z.name}
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
  const { data: members } = await admin.from("memberships").select("user_id, role").eq("org_id", id);
  // one lookup per member instead of listing every user of the platform
  const users = await Promise.all((members ?? []).map((m) => admin.auth.admin.getUserById(m.user_id)));

  return (
    <>
      <SectionTitle>{t.members}</SectionTitle>
      <div className="card divide-y divide-line-soft">
        {(members ?? []).map((m, i) => (
          <div key={m.user_id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
            <span className="truncate">{users[i].data.user?.email ?? m.user_id}</span>
            <span className="flex items-center gap-4">
              <span className="text-dim">{t[`role_${m.role as "owner" | "member" | "viewer"}`]}</span>
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
