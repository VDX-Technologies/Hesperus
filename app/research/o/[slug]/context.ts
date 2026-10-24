// What every Research page and action starts from: the organization and the person, as an author.
import "server-only";
import { requireConsole } from "@/lib/auth";
import { tenantDb } from "@/lib/engine/db";
import type { Author, Role } from "@/lib/engine/manual";

export async function researchContext(slug: string) {
  const { user, org, role } = await requireConsole(slug, "research");
  const author: Author = { id: user.id, email: user.email, role: role as Role };
  return { org, db: tenantDb(org.id), author };
}
