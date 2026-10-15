"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { getModule } from "@/lib/modules";
import { parseSettings } from "@/lib/settings";

/** Company-wide thresholds of one module (owner or VDX). */
export async function saveOrgSettings(formData: FormData) {
  const slug = String(formData.get("slug"));
  const back = String(formData.get("back"));
  const mod = getModule(String(formData.get("module")));
  const { supabase, org, role } = await requireOrg(slug);
  if (!mod || role !== "owner") redirect(`${back}?error=readOnly`);
  const config = parseSettings(mod, formData);
  const err = mod.validate?.({ ...mod.defaultConfig, ...config });
  if (err) redirect(`${back}?error=${err}`);
  const { error } = await supabase.from("org_modules").update({ config }).eq("org_id", org.id).eq("module", mod.id);
  if (error) redirect(`${back}?error=readOnly`);
  revalidatePath(`/o/${slug}`, "layout");
  redirect(`${back}?saved=1`);
}

/** Thresholds of one sensor (each sensor has its own complete set). */
export async function saveDeviceSettings(formData: FormData) {
  const slug = String(formData.get("slug"));
  const back = String(formData.get("back"));
  const id = String(formData.get("device"));
  const { supabase, org, role } = await requireOrg(slug);
  if (role !== "owner") redirect(`${back}?error=readOnly`);
  const { data: device } = await supabase.from("devices").select("module").eq("org_id", org.id).eq("id", id).maybeSingle();
  const mod = device && getModule(device.module);
  if (!mod) redirect(back);
  const config = parseSettings(mod, formData);
  const { data: om } = await supabase.from("org_modules").select("config").eq("org_id", org.id).eq("module", mod.id).maybeSingle();
  const err = mod.validate?.({ ...mod.defaultConfig, ...(om?.config ?? {}), ...config });
  if (err) redirect(`${back}?error=${err}`);
  await supabase.from("devices").update({ config }).eq("id", id);
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}
