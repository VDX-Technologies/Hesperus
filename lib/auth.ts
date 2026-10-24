import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasConsole } from "@/lib/consoles";

/**
 * Signed-in user + whether they are VDX staff. Redirects to /login when signed out.
 * getClaims verifies the session JWT locally (no round trip to the auth server when the project
 * uses asymmetric signing keys); cache() shares the result between the layout and the page.
 */
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const id = data?.claims.sub;
  if (!id) redirect("/login");
  const user = { id, email: data.claims.email as string | undefined };
  const { data: admin } = await supabase.from("platform_admins").select("user_id").eq("user_id", id).maybeSingle();
  return { supabase, user, isAdmin: !!admin };
});

export async function requireAdmin() {
  const ctx = await requireUser();
  if (!ctx.isAdmin) redirect("/");
  return ctx;
}

/** Organization by slug, visible to this user through RLS (null = no access). */
export const requireOrg = cache(async (slug: string) => {
  const ctx = await requireUser();
  const { data: org } = await ctx.supabase.from("organizations").select("*").eq("slug", slug).maybeSingle();
  if (!org) redirect("/");
  const [{ data: mods }, { data: m }] = await Promise.all([
    ctx.supabase.from("org_modules").select("module, enabled, config").eq("org_id", org.id),
    ctx.supabase.from("memberships").select("role").eq("org_id", org.id).eq("user_id", ctx.user.id).maybeSingle(),
  ]);
  return { ...ctx, org, modules: (mods ?? []).filter((x) => x.enabled), role: (m?.role as string) ?? (ctx.isAdmin ? "owner" : "viewer") };
});

/** requireOrg for the pages of one console: they do not exist for organizations without it. */
export async function requireConsole(slug: string, id: string) {
  const ctx = await requireOrg(slug);
  if (!hasConsole(ctx.org, id)) notFound();
  return ctx;
}
