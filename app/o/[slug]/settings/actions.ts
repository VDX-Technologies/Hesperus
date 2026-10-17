"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { getPool } from "@/lib/engine/db";
import { upsertRules } from "@/lib/engine/rules";
import { getPackageDef } from "@/lib/packages/ui";
import { safePath } from "@/lib/safe-path";
import { parseSettings } from "@/lib/settings";

/** Company-wide thresholds of one module (owner or VDX), applied as the module's engine rules. */
export async function saveOrgSettings(formData: FormData) {
  const slug = String(formData.get("slug"));
  const back = safePath(formData.get("back"));
  const mod = getPackageDef(String(formData.get("module")));
  const { supabase, org, role } = await requireOrg(slug);
  if (!mod || role !== "owner") redirect(`${back}?error=readOnly`);
  const config = parseSettings(mod.settings, formData);
  const err = mod.validate?.({ ...mod.defaults, ...config });
  if (err) redirect(`${back}?error=${err}`);
  const { error } = await supabase.from("org_modules").update({ config }).eq("org_id", org.id).eq("module", mod.id);
  if (error) redirect(`${back}?error=readOnly`);
  await upsertRules(getPool(), org.id, mod.id, mod.rules(config), null);
  revalidatePath(`/o/${slug}`, "layout");
  redirect(`${back}?saved=1`);
}

/** Thresholds of one object (each has its own complete set), applied as its rule overrides. */
export async function saveDeviceSettings(formData: FormData) {
  const slug = String(formData.get("slug"));
  const back = safePath(formData.get("back"));
  const id = String(formData.get("device"));
  const { org, role, modules } = await requireOrg(slug);
  if (role !== "owner") redirect(`${back}?error=readOnly`);
  const db = getPool();
  const { rows } = await db.query<{ module: string }>(
    `select t.module from objects o join object_types t on t.id = o.type_id where o.tenant_id = $1 and o.id = $2`,
    [org.id, id],
  );
  const mod = rows[0] && getPackageDef(rows[0].module);
  if (!mod) redirect(back);
  const config = parseSettings(mod.settings, formData);
  const orgCfg = modules.find((m) => m.module === mod.id)?.config ?? {};
  const merged = { ...mod.defaults, ...orgCfg, ...config };
  const err = mod.validate?.(merged);
  if (err) redirect(`${back}?error=${err}`);
  await db.query(
    `update objects set properties = properties || jsonb_build_object('config', $3::jsonb) where tenant_id = $1 and id = $2`,
    [org.id, id, JSON.stringify(config)],
  );
  await upsertRules(db, org.id, mod.id, mod.rules(merged), id);
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}
