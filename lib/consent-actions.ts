"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { tenantDb } from "@/lib/engine/db";
import { record } from "@/lib/engine/audit";
import { CONSENT_VERSION } from "@/lib/consent";
import { safePath } from "@/lib/safe-path";

export async function signConsent(formData: FormData) {
  const slug = String(formData.get("slug"));
  const back = safePath(formData.get("back"));
  const name = String(formData.get("name") ?? "").trim().replace(/\s+/g, " ");
  const { supabase, user, org } = await requireOrg(slug);
  if (formData.get("accept") !== "on" || name.length < 2 || name.length > 200) redirect(back);
  const { error } = await supabase.from("research_consents").insert({
    user_id: user.id,
    version: CONSENT_VERSION,
    signed_name: name,
    user_agent: ((await headers()).get("user-agent") ?? "").slice(0, 300),
  });
  if (error && error.code !== "23505") throw new Error(error.message);
  if (!error) await record(tenantDb(org.id), user, "consent.sign", { subject: "research", data: { version: CONSENT_VERSION } });
  revalidatePath("/", "layout");
  redirect(back);
}

export async function setConsent(formData: FormData) {
  const slug = String(formData.get("slug"));
  const back = safePath(formData.get("back"));
  const granted = formData.get("granted") === "1";
  const { supabase, user, org } = await requireOrg(slug);
  const { data, error } = await supabase
    .from("research_consents")
    .update({ granted, changed_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .select("user_id");
  if (error || !data?.length) redirect(`${back}?error=consentFailed`);
  await record(tenantDb(org.id), user, granted ? "consent.grant" : "consent.withdraw", { subject: "research" });
  revalidatePath("/", "layout");
  redirect(`${back}?saved=consent`);
}
