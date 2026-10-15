import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** Signed-in user + whether they are VDX staff. Redirects to /login when signed out. */
export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: admin } = await supabase.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  return { supabase, user, isAdmin: !!admin };
}

export async function requireAdmin() {
  const ctx = await requireUser();
  if (!ctx.isAdmin) redirect("/");
  return ctx;
}

/** Organization by slug, visible to this user through RLS (null = no access). */
export async function requireOrg(slug: string) {
  const ctx = await requireUser();
  const { data: org } = await ctx.supabase.from("organizations").select("*").eq("slug", slug).maybeSingle();
  if (!org) redirect("/");
  const { data: mods } = await ctx.supabase.from("org_modules").select("module, enabled, config").eq("org_id", org.id);
  const { data: m } = await ctx.supabase
    .from("memberships")
    .select("role")
    .eq("org_id", org.id)
    .eq("user_id", ctx.user.id)
    .maybeSingle();
  return { ...ctx, org, modules: (mods ?? []).filter((x) => x.enabled), role: (m?.role as string) ?? (ctx.isAdmin ? "owner" : "viewer") };
}
