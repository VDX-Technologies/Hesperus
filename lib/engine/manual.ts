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
import { validateProperties, type Schema } from "./schema";

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

/** What the connector needs to know about an event type, wherever it is defined. */
export interface EventSpec {
  /** Full type, "agronomy.treatment" or "custom.pruning". */
  type: string;
  module: string;
  fields: Schema;
  /** Object type ("agronomy.crop") every object of the event must have. */
  subject?: string | null;
  /** Object types the objects after the first may also have (a run's datasets, after its project). */
  also?: string[];
  /** Registered before the first event, when the type comes from a package. */
  pkg?: ModulePackage;
}

const specOf = (pkg: ModulePackage, key: string): EventSpec => {
  const def = pkg.eventTypes?.find((t) => t.key === key);
  if (!def) throw new ManualEventError(400, `unknown event type "${key}"`);
  return { type: `${pkg.id}.${key}`, module: pkg.id, fields: def.fields, subject: def.subject, also: def.also, pkg };
};

type EventInput = { ts: Date; payload: Record<string, unknown>; objectIds: string[] };

async function check(db: TenantDb, spec: EventSpec, author: Author, input: EventInput, now: Date) {
  if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot record events");
  const ids = await checkEvent(db, spec, input);
  const day = await db.query<{ n: number }>(
    `select count(*)::int n from events where tenant_id = $1 and author is not null and recorded_at > $2::timestamptz - interval '1 day'`,
    [db.tenantId, now],
  );
  if (day.rows[0].n >= num(await getSettings(db.shared), "manual.events_per_day", 500)) throw new ManualEventError(429, "daily limit reached");

  if (spec.pkg) await registerPackage(db.shared, spec.pkg);
  return ids;
}

/** Time, payload and objects of an event of the spec's type, whoever brings it. Returns the object ids. */
export async function checkEvent(db: TenantDb, spec: EventSpec, input: EventInput): Promise<string[]> {
  if (Number.isNaN(input.ts.getTime())) throw new ManualEventError(400, "invalid event time");
  const err = validateProperties(spec.fields, input.payload);
  if (err) throw new ManualEventError(400, err);

  const settings = await getSettings(db.shared);
  const ids = [...new Set(input.objectIds)];
  if (!ids.length) throw new ManualEventError(400, "an event needs at least one object");
  if (ids.length > num(settings, "manual.max_objects", 20)) throw new ManualEventError(400, "too many objects");
  if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new ManualEventError(404, "object not found");
  const { rows } = await db.query<{ id: string; type: string; archived: boolean }>(
    `select o.id, t.module || '.' || t.key type, coalesce(o.properties->>'status' = 'archived', false) archived
       from objects o join object_types t on t.id = o.type_id where o.tenant_id = $1 and o.id = any($2::uuid[])`,
    [db.tenantId, ids],
  );
  if (rows.length !== ids.length) throw new ManualEventError(404, "object not found");
  // the first object is the subject; the others are of the subject's type or of one the type also takes
  if (spec.subject) {
    const typeOf = new Map(rows.map((r) => [r.id, r.type]));
    const others = [spec.subject, ...(spec.also ?? [])];
    if (typeOf.get(ids[0]) !== spec.subject || ids.slice(1).some((id) => !others.includes(typeOf.get(id)!)))
      throw new ManualEventError(400, `objects must be of type "${spec.subject}"`);
  }
  if (rows.some((r) => r.archived)) throw new ManualEventError(409, "object is archived");
  return ids;
}

async function insert(
  db: TenantDb,
  source: Source,
  author: Author,
  e: { type: string; ts: Date; severity: Severity; payload: Record<string, unknown>; objectIds: string[]; supersedes: number | null; voided?: string },
  now: Date,
): Promise<number> {
  await db.query(`insert into raw_inbox (tenant_id, source_id, received_at, body) values ($1, $2, $3, $4)`, [
    db.tenantId, source.id, now, JSON.stringify({ manual: true, author: author.id, ...e, ts: e.ts.toISOString() }),
  ]);
  try {
    // one statement: the event and its links land together or not at all
    const { rows } = await db.query<{ id: string }>(
      `with e as (
         insert into events (tenant_id, ts, type, severity, payload, source_id, recorded_at, author, author_label, supersedes, voided)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $12) returning id
       )
       insert into event_objects (tenant_id, event_id, object_id)
       select $1, e.id, o from e, unnest($11::uuid[]) o returning event_id id`,
      [db.tenantId, e.ts, e.type, e.severity, e.payload, source.id, now, author.id, author.email ?? null, e.supersedes, e.objectIds, e.voided ?? null],
    );
    return Number(rows[0].id);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") throw new ManualEventError(409, "this version was already corrected");
    if (code === "23514") throw new ManualEventError(400, (err as Error).message);
    throw err;
  }
}

/** Records an event of any type entered by a person, linked to one or more objects. Returns its id. */
export async function recordEvent(db: TenantDb, spec: EventSpec, author: Author, input: EventInput & { severity?: Severity }, now = new Date()): Promise<number> {
  const objectIds = await check(db, spec, author, input, now);
  const source = await manualSource(db, spec.module);
  const id = await insert(db, source, author, { type: spec.type, ts: input.ts, severity: input.severity ?? "info", payload: input.payload, objectIds, supersedes: null }, now);
  await record(db, author, "event.create", { objectId: objectIds[0], subject: spec.type, data: { event: id, ts: input.ts.toISOString(), payload: input.payload, objects: objectIds } });
  return id;
}

/**
 * Records a new version of a manual event of the spec's type. Only the latest version can be
 * corrected; the objects stay the same unless given. Returns the new version's id.
 */
export async function correctEvent(
  db: TenantDb,
  spec: EventSpec,
  author: Author,
  eventId: number,
  input: { ts: Date; payload: Record<string, unknown>; objectIds?: string[] },
  now = new Date(),
): Promise<number> {
  const { rows } = await db.query<{ type: string; severity: Severity; author: string | null; objects: string[]; latest: boolean; voided: string | null }>(
    `select e.type, e.severity, e.author, e.voided,
            array(select object_id from event_objects where tenant_id = $1 and event_id = e.id) objects,
            not exists (select 1 from events n where n.tenant_id = $1 and n.supersedes = e.id) latest
       from events e where e.tenant_id = $1 and e.id = $2`,
    [db.tenantId, eventId],
  );
  const prev = rows[0];
  if (!prev || !prev.author || prev.type !== spec.type) throw new ManualEventError(404, "event not found");
  if (!prev.latest) throw new ManualEventError(409, "this version was already corrected");
  if (prev.voided) throw new ManualEventError(409, "this event was voided");

  const objectIds = await check(db, spec, author, { ts: input.ts, payload: input.payload, objectIds: input.objectIds ?? prev.objects }, now);
  const source = await manualSource(db, spec.module);
  const id = await insert(db, source, author, { type: prev.type, ts: input.ts, severity: prev.severity, payload: input.payload, objectIds, supersedes: eventId }, now);
  await record(db, author, "event.correct", {
    objectId: objectIds[0], subject: prev.type, data: { event: id, supersedes: eventId, ts: input.ts.toISOString(), payload: input.payload, objects: objectIds },
  });
  return id;
}

/**
 * Voids a manual event: a last version with the same payload, time and objects that says why it
 * no longer counts. It drops out of lists, dashboards and exports and stays in the history.
 */
export async function voidEvent(db: TenantDb, author: Author, eventId: number, reason: string, now = new Date()): Promise<number> {
  if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot void events");
  const why = reason.trim();
  if (!why) throw new ManualEventError(400, "a reason is required");
  const { rows } = await db.query<{ type: string; ts: Date; severity: Severity; payload: Record<string, unknown>; author: string | null; voided: string | null; objects: string[]; latest: boolean }>(
    `select e.type, e.ts, e.severity, e.payload, e.author, e.voided,
            array(select object_id from event_objects where tenant_id = $1 and event_id = e.id) objects,
            not exists (select 1 from events n where n.tenant_id = $1 and n.supersedes = e.id) latest
       from events e where e.tenant_id = $1 and e.id = $2`,
    [db.tenantId, eventId],
  );
  const prev = rows[0];
  if (!prev || !prev.author) throw new ManualEventError(404, "event not found");
  if (prev.voided) throw new ManualEventError(409, "this event was already voided");
  if (!prev.latest) throw new ManualEventError(409, "this version was already corrected");
  const source = await manualSource(db, prev.type.split(".")[0]);
  const id = await insert(db, source, author, { type: prev.type, ts: prev.ts, severity: prev.severity, payload: prev.payload, objectIds: prev.objects, supersedes: eventId, voided: why }, now);
  await record(db, author, "event.void", {
    objectId: prev.objects[0], subject: prev.type, data: { event: id, supersedes: eventId, reason: why },
  });
  return id;
}

/** Records an event of a package type (`input.type` is the key inside the package). */
export async function createManualEvent(db: TenantDb, pkg: ModulePackage, author: Author, input: ManualInput, now = new Date()): Promise<number> {
  if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot record events");
  return recordEvent(db, specOf(pkg, input.type), author, input, now);
}

/** Corrects an event of a package type. */
export async function correctManualEvent(
  db: TenantDb,
  pkg: ModulePackage,
  author: Author,
  eventId: number,
  input: { ts: Date; payload: Record<string, unknown>; objectIds?: string[] },
  now = new Date(),
): Promise<number> {
  const { rows } = await db.query<{ type: string }>(`select type from events where tenant_id = $1 and id = $2`, [db.tenantId, eventId]);
  if (!rows[0]?.type.startsWith(`${pkg.id}.`)) throw new ManualEventError(404, "event not found");
  return correctEvent(db, specOf(pkg, rows[0].type.slice(pkg.id.length + 1)), author, eventId, input, now);
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

async function manualObject(db: TenantDb, pkg: ModulePackage, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ManualEventError(404, "object not found");
  const { rows } = await db.query<{ key: string; name: string | null; properties: Record<string, unknown> }>(
    `select t.key, o.name, o.properties from objects o join object_types t on t.id = o.type_id
      where o.tenant_id = $1 and o.id = $2 and t.module = $3 and o.external_id is null`,
    [db.tenantId, id, pkg.id],
  );
  if (!rows[0]) throw new ManualEventError(404, "object not found");
  return rows[0];
}

/** Replaces the properties of an object of the package (validated against its type); `status` stays as it is. */
export async function updateManualObject(db: TenantDb, pkg: ModulePackage, author: Author, id: string, properties: Record<string, unknown>): Promise<void> {
  const o = await manualObject(db, pkg, id);
  const { status: _, ...rest } = properties;
  const next = { ...rest, ...(o.properties.status !== undefined ? { status: o.properties.status } : {}) };
  await checkObject(db, pkg, author, o.key, next);
  await db.query(`update objects set properties = $3 where tenant_id = $1 and id = $2`, [db.tenantId, id, next]);
  await record(db, author, "object.update", { objectId: id, subject: o.name, data: { before: o.properties, properties: next } });
}

/**
 * Archives an object: an end (the given day, else the one it has, else today) and status
 * "archived". It leaves the active lists and the entry menus; its events stay as they are.
 */
export async function archiveManualObject(db: TenantDb, pkg: ModulePackage, author: Author, id: string, end?: Date, now = new Date()): Promise<void> {
  const o = await manualObject(db, pkg, id);
  if (o.properties.status === "archived") throw new ManualEventError(409, "object is archived");
  const day = end && !Number.isNaN(end.getTime()) ? end : o.properties.end ? new Date(String(o.properties.end)) : now;
  const next = { ...o.properties, end: day.toISOString(), status: "archived" };
  await checkObject(db, pkg, author, o.key, next);
  await db.query(`update objects set properties = $3 where tenant_id = $1 and id = $2`, [db.tenantId, id, next]);
  await record(db, author, "object.archive", { objectId: id, subject: o.name, data: { end: next.end } });
}

/** Deletes an object entered by hand, only when no event points at it: those are archived instead. */
export async function deleteManualObject(db: TenantDb, pkg: ModulePackage, author: Author, id: string): Promise<void> {
  const o = await manualObject(db, pkg, id);
  if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot delete objects");
  const ev = await db.query(`select 1 from event_objects where tenant_id = $1 and object_id = $2 limit 1`, [db.tenantId, id]);
  if (ev.rowCount) throw new ManualEventError(409, "object has events: archive it");
  await db.query(`delete from links where tenant_id = $1 and (src_id = $2 or dst_id = $2)`, [db.tenantId, id]);
  await db.query(`delete from objects where tenant_id = $1 and id = $2`, [db.tenantId, id]);
  await record(db, author, "object.delete", { objectId: id, subject: o.name, data: { properties: o.properties } });
}
