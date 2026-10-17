import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getT, timeAgo } from "@/lib/i18n";
import { getPool } from "@/lib/engine/db";
import { upsertRules } from "@/lib/engine/rules";
import { listObjects } from "@/lib/packages/console";
import { getPackageDef, PACKAGES, UPCOMING } from "@/lib/packages/ui";
import { parseSettings } from "@/lib/settings";
import { SettingsForm } from "@/components/settings-form";
import { createAdminClient } from "@/lib/supabase/admin";
import { SectionTitle } from "@/components/ui";

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

export default async function OrgAdmin(props: PageProps<"/admin/orgs/[id]">) {
  const { id } = await props.params;
  const { supabase } = await requireAdmin();
  const { t, locale } = await getT();
  const { data: org } = await supabase.from("organizations").select("*").eq("id", id).maybeSingle();
  if (!org) notFound();
  const [mods, sites, zones, members] = await Promise.all([
    supabase.from("org_modules").select("module, enabled, config").eq("org_id", id),
    supabase.from("sites").select("id, name").eq("org_id", id).order("name"),
    supabase.from("zones").select("id, name, site_id").eq("org_id", id).order("name"),
    createAdminClient().from("memberships").select("user_id, role").eq("org_id", id),
  ]);
  const enabled = new Map((mods.data ?? []).map((m) => [m.module, m]));
  const devices = (await Promise.all(Object.keys(PACKAGES).map((m) => listObjects(getPool(), id, m)))).flat();
  const { data: users } = await createAdminClient().auth.admin.listUsers();
  const emailOf = new Map((users?.users ?? []).map((u) => [u.id, u.email]));
  const siteName = new Map((sites.data ?? []).map((s) => [s.id, s.name]));

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

      {Object.values(PACKAGES)
        .filter((m) => enabled.get(m.id)?.enabled && m.settings.length)
        .map((m) => (
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

      <SectionTitle>{t.sitesZones}</SectionTitle>
      <div className="card p-5">
        <ul className="space-y-1 text-sm">
          {(sites.data ?? []).map((s) => (
            <li key={s.id}>
              <span className="font-medium">{s.name}</span>
              <span className="text-mist">
                {" "}
                · {(zones.data ?? []).filter((z) => z.site_id === s.id).map((z) => z.name).join(", ") || "–"}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap gap-6">
          <form action={addSite} className="flex gap-2">
            <input type="hidden" name="org" value={id} />
            <input name="name" placeholder={t.newSite} required />
            <button className="btn">+</button>
          </form>
          {!!sites.data?.length && (
            <form action={addZone} className="flex gap-2">
              <input type="hidden" name="org" value={id} />
              <select name="site">
                {sites.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <input name="name" placeholder={t.newZone} required />
              <button className="btn">+</button>
            </form>
          )}
        </div>
      </div>

      <SectionTitle>{t.devices}</SectionTitle>
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

      <p className="mt-2 text-xs text-dim">
        <Link href="/admin/engine" className="hover:text-frost">
          {t.sources} →
        </Link>
      </p>

      <SectionTitle>{t.members}</SectionTitle>
      <div className="card p-5">
        <ul className="space-y-1 text-sm">
          {(members.data ?? []).map((m) => (
            <li key={m.user_id}>
              {emailOf.get(m.user_id)} <span className="text-dim">· {t[`role_${m.role as "owner" | "member" | "viewer"}`]}</span>
            </li>
          ))}
        </ul>
        <form action={addMember} className="mt-4 flex flex-wrap gap-2">
          <input type="hidden" name="org" value={id} />
          <input name="email" type="email" placeholder={t.email} required />
          <input name="password" placeholder={t.tempPassword} minLength={8} required />
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
    </div>
  );
}
