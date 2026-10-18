// Reads for the Records console: entry events with their subject, newest first.
import "server-only";
import type { TenantDb } from "../../engine/db";

export interface RecordEntry {
  id: string;
  ts: string;
  objectId: string;
  subject: string;
  payload: Record<string, unknown>;
}

export async function listEntries(db: TenantDb, opts: { objectId?: string; limit?: number } = {}): Promise<RecordEntry[]> {
  const { rows } = await db.query<{ id: string; ts: Date; object_id: string; name: string | null; payload: Record<string, unknown> }>(
    `select e.id, e.ts, o.id object_id, o.name, e.payload
     from events e
     join event_objects eo on eo.tenant_id = e.tenant_id and eo.event_id = e.id
     join objects o on o.tenant_id = e.tenant_id and o.id = eo.object_id
     where e.tenant_id = $1 and e.type = 'records.entry' and ($2::uuid is null or o.id = $2)
     order by e.ts desc, e.id desc limit $3`,
    [db.tenantId, opts.objectId ?? null, opts.limit ?? 50],
  );
  return rows.map((r) => ({ id: String(r.id), ts: r.ts.toISOString(), objectId: r.object_id, subject: r.name ?? "", payload: r.payload }));
}
