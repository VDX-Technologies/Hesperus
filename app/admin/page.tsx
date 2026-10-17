import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { SectionTitle } from "@/components/ui";

async function createOrg(formData: FormData) {
  "use server";
  const { supabase } = await requireAdmin();
  const name = String(formData.get("name")).trim();
  const slug = String(formData.get("slug") || name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const { data, error } = await supabase
    .from("organizations")
    .insert({ name, slug, locale: formData.get("locale") === "it" ? "it" : "en" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  redirect(`/admin/orgs/${data.id}`);
}

export default async function AdminHome() {
  const { supabase } = await requireAdmin();
  const { t } = await getT();
  const { data: orgs, error } = await supabase.from("organizations").select("id, name, slug, org_modules(module, enabled), objects(count)").order("name");
  if (error) throw new Error(error.message);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.customers}</h1>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(orgs ?? []).map((o) => (
          <Link key={o.id} href={`/admin/orgs/${o.id}`} className="card block p-5 hover:border-line">
            <div className="text-lg font-medium">{o.name}</div>
            <div className="num text-xs text-dim">/{o.slug}</div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(o.org_modules ?? [])
                .filter((m) => m.enabled)
                .map((m) => (
                  <span key={m.module} className="rounded-full border border-line px-2 py-0.5 text-xs capitalize text-mist">
                    {m.module}
                  </span>
                ))}
            </div>
            <div className="mt-3 text-xs text-dim">
              {t.devices}: <span className="num">{(o.objects as unknown as { count: number }[])?.[0]?.count ?? 0}</span>
            </div>
          </Link>
        ))}
      </div>
      <SectionTitle>{t.newCustomer}</SectionTitle>
      <form action={createOrg} className="card flex flex-wrap items-end gap-3 p-5">
        <label className="flex flex-col gap-1 text-sm text-mist">
          {t.name}
          <input name="name" required />
        </label>
        <label className="flex flex-col gap-1 text-sm text-mist">
          {t.slug}
          <input name="slug" placeholder="auto" />
        </label>
        <label className="flex flex-col gap-1 text-sm text-mist">
          {t.language}
          <select name="locale" defaultValue="it">
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </select>
        </label>
        <button className="btn">{t.create}</button>
      </form>
    </div>
  );
}
