import "server-only";
import { requireConsole } from "@/lib/auth";
import { tenantDb } from "@/lib/engine/db";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Author, Role } from "@/lib/engine/manual";

export async function researchContext(slug: string) {
  const { user, org, role } = await requireConsole(slug, "research");
  const author: Author = { id: user.id, email: user.email, role: role as Role };
  return { org, db: tenantDb(org.id), author };
}

export async function assignees(orgId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("memberships").select("user_id, role").eq("org_id", orgId).in("role", ["owner", "member"]);
  if (error) throw new Error(error.message);
  const users = await Promise.all((data ?? []).map((m) => admin.auth.admin.getUserById(m.user_id)));
  return users.flatMap((u) => (u.data.user?.email ? [u.data.user.email] : [])).sort();
}
