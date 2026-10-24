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
  /** Why the event was voided, on the version that voids it. */
  voided: string | null;
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
  /** Only the voided events (their voiding version). */
  voided?: boolean;
  limit?: number;
  /** Paging: events older than this id. */
  before?: number;
  /** Keyset paging: events after this one in the chosen order (never an offset). */
  after?: Cursor;
  /** Oldest first instead of newest first. */
  asc?: boolean;
}

/** Position of an event in (ts, id) order. */
export type Cursor = { ts: Date; id: number };

export const cursorOf = (e: { ts: Date; id: number }): string => `${e.ts.toISOString()}_${e.id}`;
export function parseCursor(s: string | null | undefined): Cursor | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)_(\d+)$/.exec(s ?? "");
  if (!m) return undefined;
  const ts = new Date(m[1]);
  return Number.isNaN(ts.getTime()) ? undefined : { ts, id: Number(m[2]) };
}

const COLS = `e.id, e.ts, e.recorded_at, e.type, e.severity, e.payload, e.source_id, e.author, e.author_label, e.supersedes, e.voided,
  coalesce(e.root_id, e.id) root_id,
  (select count(*)::int from events v where v.tenant_id = $1 and coalesce(v.root_id, v.id) = coalesce(e.root_id, e.id) and v.id <= e.id) version,
  array(select eo.object_id from event_objects eo where eo.tenant_id = $1 and eo.event_id = e.id order by eo.pos, eo.object_id) object_ids`;

type Raw = {
  id: string; ts: Date; recorded_at: Date; type: string; severity: Severity; payload: Record<string, unknown>; source_id: string | null;
  author: string | null; author_label: string | null; supersedes: string | null; voided: string | null; root_id: string; version: number; object_ids: string[];
};

const toRow = (r: Raw): EventRow => ({
  id: Number(r.id), ts: r.ts, recordedAt: r.recorded_at, type: r.type, severity: r.severity, payload: r.payload, sourceId: r.source_id,
  author: r.author, authorLabel: r.author_label, supersedes: r.supersedes === null ? null : Number(r.supersedes), voided: r.voided, rootId: Number(r.root_id),
  version: r.version, objectIds: r.object_ids,
});

/** Newest event time first (then newest id), or oldest first with `asc`. */
export async function listEvents(db: TenantDb, q: EventQuery = {}): Promise<EventRow[]> {
  const table = q.current === false ? "events" : q.voided ? "(select * from events where voided is not null)" : "events_current";
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
        and ($11::timestamptz is null or ${q.asc ? "(e.ts, e.id) > ($11, $12::bigint)" : "(e.ts, e.id) < ($11, $12::bigint)"})
      order by e.ts ${q.asc ? "asc" : "desc"}, e.id ${q.asc ? "asc" : "desc"} limit $10`,
    [
      db.tenantId, q.objectId ?? null, q.recursive ?? true, q.types ?? null, q.from ?? null, q.to ?? null,
      q.payload ? JSON.stringify(q.payload) : null, q.author ?? null, q.before ?? null, Math.min(q.limit ?? 100, 1000),
      q.after?.ts ?? null, q.after?.id ?? null,
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

/** Every matching event, read `chunk` rows at a time with the keyset (for exports). */
export async function* allEvents(db: TenantDb, q: Omit<EventQuery, "limit" | "after">, chunk = 500): AsyncGenerator<EventRow> {
  let after: Cursor | undefined;
  for (;;) {
    const rows = await listEvents(db, { ...q, after, limit: chunk });
    yield* rows;
    if (rows.length < chunk) return;
    after = rows[rows.length - 1];
  }
}

export interface DashboardEvent {
  id: number;
  ts: Date;
  type: string;
  payload: Record<string, unknown>;
  authorLabel: string | null;
  objectIds: string[];
}

/** Lightweight paged event reads for dashboard aggregates; omit version-history work. */
export async function* allDashboardEvents(
  db: TenantDb,
  q: { types: string[]; from?: Date; to?: Date },
  chunk = 1000,
): AsyncGenerator<DashboardEvent> {
  let after: Cursor | undefined;
  for (;;) {
    const { rows } = await db.query<{ id: string; ts: Date; type: string; payload: Record<string, unknown>; author_label: string | null; object_ids: string[] }>(
      `with page as (
         select e.id, e.ts, e.type, e.payload, e.author_label
         from events_current e
         where e.tenant_id = $1 and e.type = any($2::text[])
           and ($3::timestamptz is null or e.ts >= $3)
           and ($4::timestamptz is null or e.ts < $4)
           and ($5::timestamptz is null or (e.ts, e.id) < ($5, $6::bigint))
         order by e.ts desc, e.id desc
         limit $7
       )
       select p.id, p.ts, p.type, p.payload, p.author_label,
              array(select eo.object_id from event_objects eo where eo.tenant_id = $1 and eo.event_id = p.id order by eo.pos, eo.object_id) object_ids
       from page p order by p.ts desc, p.id desc`,
      [db.tenantId, q.types, q.from ?? null, q.to ?? null, after?.ts ?? null, after?.id ?? null, chunk],
    );
    const page = rows.map((r) => ({
      id: Number(r.id), ts: r.ts, type: r.type, payload: r.payload, authorLabel: r.author_label, objectIds: r.object_ids,
    }));
    yield* page;
    if (page.length < chunk) return;
    const last = page[page.length - 1];
    after = { ts: last.ts, id: last.id };
  }
}

/** Latest event for each tracked object and register type, independent of dashboard period. */
export async function latestDashboardObjectEvents(db: TenantDb, objectIds: string[], types: string[]): Promise<DashboardEvent[]> {
  if (!objectIds.length || !types.length) return [];
  const { rows } = await db.query<{ id: string; ts: Date; type: string; payload: Record<string, unknown>; author_label: string | null; object_id: string }>(
    `select distinct on (eo.object_id, e.type) e.id, e.ts, e.type, e.payload, e.author_label, eo.object_id
       from event_objects eo
       join events_current e on e.tenant_id = eo.tenant_id and e.id = eo.event_id
      where eo.tenant_id = $1 and eo.object_id = any($2::uuid[]) and e.type = any($3::text[])
      order by eo.object_id, e.type, e.ts desc, e.id desc`,
    [db.tenantId, objectIds, types],
  );
  return rows.map((r) => ({
    id: Number(r.id), ts: r.ts, type: r.type, payload: r.payload, authorLabel: r.author_label, objectIds: [r.object_id],
  }));
}

/** Latest timestamp per register type, including events without an object link. */
export async function latestDashboardEventTimes(db: TenantDb, types: string[]): Promise<Map<string, Date>> {
  if (!types.length) return new Map();
  const { rows } = await db.query<{ type: string; ts: Date }>(
    `select e.type, max(e.ts) ts from events_current e where e.tenant_id = $1 and e.type = any($2::text[]) group by e.type`,
    [db.tenantId, types],
  );
  return new Map(rows.map((r) => [r.type, r.ts]));
}
