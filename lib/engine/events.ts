// Generic event reads: by object (with everything placed below it), by type, by period, by
// payload fields, and the version history of a corrected event. Only latest versions unless
// asked otherwise.
import type { TenantDb } from "./db";
import type { Severity } from "./package";

export interface EventRow {
  id: number;
  ts: Date;
  recordedAt: Date;
  type: string;
  severity: Severity;
  payload: Record<string, unknown>;
  sourceId: string | null;
  author: string | null;
  authorLabel: string | null;
  supersedes: number | null;
  rootId: number;
  /** 1 for the first version, 2 for its first correction, ... */
  version: number;
  objectIds: string[];
}

export interface EventQuery {
  /** Events of this object; with `recursive` (default) also of the places and objects below it. */
  objectId?: string;
  recursive?: boolean;
  types?: string[];
  from?: Date;
  to?: Date;
  /** Payload must contain these values (jsonb containment). */
  payload?: Record<string, unknown>;
  author?: string;
  /** false = every version, not only the latest. */
  current?: boolean;
  limit?: number;
  /** Paging: events older than this id. */
  before?: number;
}

const COLS = `e.id, e.ts, e.recorded_at, e.type, e.severity, e.payload, e.source_id, e.author, e.author_label, e.supersedes,
  coalesce(e.root_id, e.id) root_id,
  (select count(*)::int from events v where v.tenant_id = $1 and coalesce(v.root_id, v.id) = coalesce(e.root_id, e.id) and v.id <= e.id) version,
  array(select eo.object_id from event_objects eo where eo.tenant_id = $1 and eo.event_id = e.id) object_ids`;

type Raw = {
  id: string; ts: Date; recorded_at: Date; type: string; severity: Severity; payload: Record<string, unknown>; source_id: string | null;
  author: string | null; author_label: string | null; supersedes: string | null; root_id: string; version: number; object_ids: string[];
};

const toRow = (r: Raw): EventRow => ({
  id: Number(r.id), ts: r.ts, recordedAt: r.recorded_at, type: r.type, severity: r.severity, payload: r.payload, sourceId: r.source_id,
  author: r.author, authorLabel: r.author_label, supersedes: r.supersedes === null ? null : Number(r.supersedes), rootId: Number(r.root_id),
  version: r.version, objectIds: r.object_ids,
});

/** Newest event time first (then newest id). */
export async function listEvents(db: TenantDb, q: EventQuery = {}): Promise<EventRow[]> {
  const table = q.current === false ? "events" : "events_current";
  const { rows } = await db.query<Raw>(
    `with recursive scope(id) as (
       select $2::uuid where $2::uuid is not null
       union
       select l.src_id from links l join scope s on l.dst_id = s.id
        where l.tenant_id = $1 and $3 and l.type in ('part_of', 'located_in')
     )
     select ${COLS} from ${table} e
      where e.tenant_id = $1
        and ($2::uuid is null or exists (select 1 from event_objects eo where eo.tenant_id = $1 and eo.event_id = e.id and eo.object_id in (select id from scope)))
        and ($4::text[] is null or e.type = any($4))
        and ($5::timestamptz is null or e.ts >= $5)
        and ($6::timestamptz is null or e.ts < $6)
        and ($7::jsonb is null or e.payload @> $7)
        and ($8::uuid is null or e.author = $8)
        and ($9::bigint is null or e.id < $9)
      order by e.ts desc, e.id desc limit $10`,
    [
      db.tenantId, q.objectId ?? null, q.recursive ?? true, q.types ?? null, q.from ?? null, q.to ?? null,
      q.payload ? JSON.stringify(q.payload) : null, q.author ?? null, q.before ?? null, Math.min(q.limit ?? 100, 1000),
    ],
  );
  return rows.map(toRow);
}

/** The latest event of a type recorded by a user (for "repeat last"); null when none. */
export async function lastEventBy(db: TenantDb, userId: string, type: string): Promise<EventRow | null> {
  const { rows } = await db.query<Raw>(
    `select ${COLS} from events_current e where e.tenant_id = $1 and e.author = $2 and e.type = $3
      order by e.recorded_at desc, e.id desc limit 1`,
    [db.tenantId, userId, type],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

export async function getEvent(db: TenantDb, id: number): Promise<EventRow | null> {
  const { rows } = await db.query<Raw>(`select ${COLS} from events e where e.tenant_id = $1 and e.id = $2`, [db.tenantId, id]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** Every version of the event's chain, first version first. */
export async function eventHistory(db: TenantDb, id: number): Promise<EventRow[]> {
  const { rows } = await db.query<Raw>(
    `select ${COLS} from events e
      where e.tenant_id = $1
        and coalesce(e.root_id, e.id) = (select coalesce(root_id, id) from events where tenant_id = $1 and id = $2)
      order by e.id`,
    [db.tenantId, id],
  );
  return rows.map(toRow);
}
