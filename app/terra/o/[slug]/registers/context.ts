import "server-only";
import { requireOrg } from "@/lib/auth";
import { tenantDb } from "@/lib/engine/db";
import type { Author, Role } from "@/lib/engine/manual";
import type { ModulePackage } from "@/lib/engine/package";
import { getEventType, subjectObjects, type EventTypeInfo } from "@/lib/engine/registers";
import { getPackage } from "@/lib/packages";

export async function registerContext(slug: string) {
  const { user, org, role, modules } = await requireOrg(slug);
  const pkgs = modules.map((m) => getPackage(m.module)).filter((p): p is ModulePackage => !!p);
  const author: Author = { id: user.id, email: user.email, role: role as Role };
  return { org, db: tenantDb(org.id), pkgs, author, user };
}

export async function typeFrom(ctx: Awaited<ReturnType<typeof registerContext>>, param: string): Promise<EventTypeInfo | null> {
  return getEventType(ctx.db, ctx.pkgs, decodeURIComponent(param));
}

export async function objectNames(ctx: Awaited<ReturnType<typeof registerContext>>, t: EventTypeInfo) {
  return new Map((await subjectObjects(ctx.db, t.subject, { all: true })).map((o) => [o.id, o.name]));
}
