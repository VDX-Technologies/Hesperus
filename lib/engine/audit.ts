import type { Db, TenantDb } from "./db";

export type Actor = { id: string | null; email?: string | null } | null;

export type AuditEntry = {
  id: number;
  at: Date;
  actor: string | null;
  actorLabel: string | null;
  action: string;
  objectId: string | null;
  subject: string | null;
  data: Record<string, unknown>;
};

export async function record(
  db: TenantDb,
  actor: Actor,
  action: string,
  opts: { objectId?: string | null; subject?: string | null; data?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await db.query(
      `insert into audit_log (tenant_id, actor, actor_label, action, object_id, subject, data)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [db.tenantId, actor?.id ?? null, actor?.email ?? null, action, opts.objectId ?? null, opts.subject ?? null, JSON.stringify(opts.data ?? {})],
    );
  } catch (e) {
    console.error("audit record failed", action, (e as Error).message);
  }
}

export async function recordPlatform(db: Db, actor: Actor, action: string, data: Record<string, unknown> = {}): Promise<void> {
  try {
    await db.query(`insert into audit_log (tenant_id, actor, actor_label, action, data) values (null, $1, $2, $3, $4)`, [
      actor?.id ?? null,
      actor?.email ?? null,
      action,
      JSON.stringify(data),
    ]);
  } catch (e) {
    console.error("audit record failed", action, (e as Error).message);
  }
}

export async function listAudit(db: TenantDb, opts: { objectId?: string; limit?: number; before?: number } = {}): Promise<AuditEntry[]> {
  const { rows } = await db.query(
    `select id, at, actor, actor_label, action, object_id, subject, data from audit_log
     where tenant_id = $1 and ($2::uuid is null or object_id = $2) and ($3::bigint is null or id < $3)
     order by id desc limit $4`,
    [db.tenantId, opts.objectId ?? null, opts.before ?? null, Math.min(opts.limit ?? 50, 500)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    at: r.at,
    actor: r.actor,
    actorLabel: r.actor_label,
    action: r.action,
    objectId: r.object_id,
    subject: r.subject,
    data: r.data,
  }));
}
