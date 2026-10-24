// What every Research page and action starts from: the organization and the person, as an author.
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

/** The emails of the members who can be assigned results (owners and members, not viewers). */
export async function assignees(orgId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("memberships").select("user_id, role").eq("org_id", orgId).in("role", ["owner", "member"]);
  if (error) throw new Error(error.message);
  // one lookup per member instead of listing every user of the platform
  const users = await Promise.all((data ?? []).map((m) => admin.auth.admin.getUserById(m.user_id)));
  return users.flatMap((u) => (u.data.user?.email ? [u.data.user.email] : [])).sort();
}
