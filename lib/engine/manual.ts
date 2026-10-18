// Manual connector: events entered by people in the console. Same path as any other source
// (raw copy first, then the event), plus who recorded it and when. Nothing is ever edited:
// a correction is a new version that supersedes the previous one, and the chain stays
// readable. Each tenant gets one manual source per module, created on first use.
import type { TenantDb } from "./db";
import type { ModulePackage, Severity } from "./package";
import type { Source } from "./sources";
import { record } from "./audit";
import { registerPackage } from "./ingest";
import { getSettings, num } from "./settings";
import { validateProperties } from "./schema";

export type Role = "owner" | "member" | "viewer";
export type Author = { id: string; email?: string | null; role: Role };

export class ManualEventError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 429, message: string) {
    super(message);
  }
}

export interface ManualInput {
  /** Event type key inside the package (stored as `${pkg.id}.${type}`). */
  type: string;
  /** When it happened. */
  ts: Date;
  payload: Record<string, unknown>;
  objectIds: string[];
  severity?: Severity;
}

export const canRecord = (role: Role | null | undefined) => role === "owner" || role === "member";

export async function manualSource(db: TenantDb, module: string): Promise<Source> {
  const cols = "id, tenant_id, name, connector, module, config, status";
  const found = await db.query<Source>(`select ${cols} from sources where tenant_id = $1 and connector = 'manual' and module = $2 limit 1`, [db.tenantId, module]);
  if (found.rows[0]) return found.rows[0];
  const { rows } = await db.query<Source>(
    `insert into sources (tenant_id, name, connector, module) values ($1, $2, 'manual', $3) returning ${cols}`,
    [db.tenantId, `Inserimento manuale (${module})`, module],
  );
  return rows[0];
}

async function check(db: TenantDb, pkg: ModulePackage, author: Author, input: Omit<ManualInput, "severity">, now: Date) {
  if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot record events");
  const def = pkg.eventTypes?.find((t) => t.key === input.type);
  if (!def) throw new ManualEventError(400, `unknown event type "${input.type}"`);
  if (Number.isNaN(input.ts.getTime())) throw new ManualEventError(400, "invalid event time");
  const err = validateProperties(def.fields, input.payload);
  if (err) throw new ManualEventError(400, err);

  const settings = await getSettings(db.shared);
  const ids = [...new Set(input.objectIds)];
  if (!ids.length) throw new ManualEventError(400, "an event needs at least one object");
  if (ids.length > num(settings, "manual.max_objects", 20)) throw new ManualEventError(400, "too many objects");
  const { rows } = await db.query<{ n: number }>(`select count(*)::int n from objects where tenant_id = $1 and id = any($2::uuid[])`, [db.tenantId, ids]);
  if (rows[0].n !== ids.length) throw new ManualEventError(404, "object not found");

  const day = await db.query<{ n: number }>(
    `select count(*)::int n from events where tenant_id = $1 and author is not null and recorded_at > $2::timestamptz - interval '1 day'`,
    [db.tenantId, now],
  );
  if (day.rows[0].n >= num(settings, "manual.events_per_day", 500)) throw new ManualEventError(429, "daily limit reached");

  await registerPackage(db.shared, pkg);
  return ids;
}

async function insert(
  db: TenantDb,
  source: Source,
  author: Author,
  e: { type: string; ts: Date; severity: Severity; payload: Record<string, unknown>; objectIds: string[]; supersedes: number | null },
  now: Date,
): Promise<number> {
  await db.query(`insert into raw_inbox (tenant_id, source_id, received_at, body) values ($1, $2, $3, $4)`, [
    db.tenantId, source.id, now, JSON.stringify({ manual: true, author: author.id, ...e, ts: e.ts.toISOString() }),
  ]);
  try {
    // one statement: the event and its links land together or not at all
    const { rows } = await db.query<{ id: string }>(
      `with e as (
         insert into events (tenant_id, ts, type, severity, payload, source_id, recorded_at, author, author_label, supersedes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id
       )
       insert into event_objects (tenant_id, event_id, object_id)
       select $1, e.id, o from e, unnest($11::uuid[]) o returning event_id id`,
      [db.tenantId, e.ts, e.type, e.severity, e.payload, source.id, now, author.id, author.email ?? null, e.supersedes, e.objectIds],
    );
    return Number(rows[0].id);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") throw new ManualEventError(409, "this version was already corrected");
    if (code === "23514") throw new ManualEventError(400, (err as Error).message);
    throw err;
  }
}

/** Records an event entered by a person, linked to one or more objects. Returns its id. */
export async function createManualEvent(db: TenantDb, pkg: ModulePackage, author: Author, input: ManualInput, now = new Date()): Promise<number> {
  const objectIds = await check(db, pkg, author, input, now);
  const source = await manualSource(db, pkg.id);
  const type = `${pkg.id}.${input.type}`;
  const id = await insert(db, source, author, { type, ts: input.ts, severity: input.severity ?? "info", payload: input.payload, objectIds, supersedes: null }, now);
  await record(db, author, "event.create", { objectId: objectIds[0], subject: type, data: { event: id, ts: input.ts.toISOString(), payload: input.payload, objects: objectIds } });
  return id;
}

/**
 * Records a new version of a manual event. Only the latest version can be corrected; the
 * objects stay the same unless given. Returns the new version's id.
 */
export async function correctManualEvent(
  db: TenantDb,
  pkg: ModulePackage,
  author: Author,
  eventId: number,
  input: { ts: Date; payload: Record<string, unknown>; objectIds?: string[] },
  now = new Date(),
): Promise<number> {
  const { rows } = await db.query<{ type: string; severity: Severity; author: string | null; objects: string[]; latest: boolean }>(
    `select e.type, e.severity, e.author,
            array(select object_id from event_objects where tenant_id = $1 and event_id = e.id) objects,
            not exists (select 1 from events n where n.tenant_id = $1 and n.supersedes = e.id) latest
       from events e where e.tenant_id = $1 and e.id = $2`,
    [db.tenantId, eventId],
  );
  const prev = rows[0];
  if (!prev || !prev.author || !prev.type.startsWith(`${pkg.id}.`)) throw new ManualEventError(404, "event not found");
  if (!prev.latest) throw new ManualEventError(409, "this version was already corrected");

  const type = prev.type.slice(pkg.id.length + 1);
  const objectIds = await check(db, pkg, author, { type, ts: input.ts, payload: input.payload, objectIds: input.objectIds ?? prev.objects }, now);
  const source = await manualSource(db, pkg.id);
  const id = await insert(db, source, author, { type: prev.type, ts: input.ts, severity: prev.severity, payload: input.payload, objectIds, supersedes: eventId }, now);
  await record(db, author, "event.correct", {
    objectId: objectIds[0], subject: prev.type, data: { event: id, supersedes: eventId, ts: input.ts.toISOString(), payload: input.payload, objects: objectIds },
  });
  return id;
}

async function checkObject(db: TenantDb, pkg: ModulePackage, author: Author, type: string, properties: Record<string, unknown>) {
  if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot create objects");
  const def = pkg.objectTypes.find((t) => t.key === type);
  if (!def) throw new ManualEventError(400, `unknown object type "${type}"`);
  const err = validateProperties(def.properties, properties);
  if (err) throw new ManualEventError(400, err);
  return (await registerPackage(db.shared, pkg)).types.get(type)!;
}

/** Creates an object entered by hand (a crop, ...), optionally located in a place. Returns its id. */
export async function createManualObject(
  db: TenantDb,
  pkg: ModulePackage,
  author: Author,
  input: { type: string; name: string; properties: Record<string, unknown>; placeId?: string | null },
): Promise<string> {
  const typeId = await checkObject(db, pkg, author, input.type, input.properties);
  const name = input.name.trim();
  if (!name) throw new ManualEventError(400, "a name is required");
  const settings = await getSettings(db.shared);
  const { rows: n } = await db.query<{ n: number }>(
    `select count(*)::int n from objects o where o.tenant_id = $1 and o.external_id is null
       and o.type_id in (select id from object_types where module = $2)`,
    [db.tenantId, pkg.id],
  );
  if (n[0].n >= num(settings, "manual.objects_max", 500)) throw new ManualEventError(429, "object limit reached");
  if (input.placeId) {
    const p = await db.query(
      `select 1 from objects o join object_types t on t.id = o.type_id
        where o.tenant_id = $1 and o.id = $2 and t.module = 'core' and t.key in ('site', 'area')`,
      [db.tenantId, input.placeId],
    );
    if (!p.rowCount) throw new ManualEventError(404, "place not found");
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into objects (tenant_id, type_id, name, properties) values ($1, $2, $3, $4) returning id`,
    [db.tenantId, typeId, name, input.properties],
  );
  const id = rows[0].id;
  if (input.placeId)
    await db.query(`insert into links (tenant_id, type, src_id, dst_id) values ($1, 'located_in', $2, $3)`, [db.tenantId, id, input.placeId]);
  await record(db, author, "object.create", { objectId: id, subject: name, data: { type: `${pkg.id}.${input.type}`, properties: input.properties, place: input.placeId ?? null } });
  return id;
}

/** Replaces the properties of an object of the package (validated against its type). */
export async function updateManualObject(db: TenantDb, pkg: ModulePackage, author: Author, id: string, properties: Record<string, unknown>): Promise<void> {
  const { rows } = await db.query<{ key: string; name: string | null }>(
    `select t.key, o.name from objects o join object_types t on t.id = o.type_id where o.tenant_id = $1 and o.id = $2 and t.module = $3`,
    [db.tenantId, id, pkg.id],
  );
  if (!rows[0]) throw new ManualEventError(404, "object not found");
  await checkObject(db, pkg, author, rows[0].key, properties);
  await db.query(`update objects set properties = $3 where tenant_id = $1 and id = $2`, [db.tenantId, id, properties]);
  await record(db, author, "object.update", { objectId: id, subject: rows[0].name, data: { properties } });
}
