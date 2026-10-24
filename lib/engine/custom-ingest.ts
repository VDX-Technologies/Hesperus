// Push for the tenant's own types (module "custom"): a program sends objects and events of the
// types defined in the schema editor, with no package behind them. Objects are matched by their
// external id, so sending the same ones again changes them in place; events carry a key of the
// sender's, so the same run sent twice is stored once. A source can be bound to one object (a
// project): what it writes is then linked to that object and nothing else.
import { createHash } from "node:crypto";
import { forTenant, inTransaction, type Db, type TenantDb } from "./db";
import type { ObjectStore } from "./store";
import type { Source } from "./sources";
import type { Actor } from "./audit";
import { record } from "./audit";
import { ConnectorError, type RawMessage } from "./connectors";
import { parseCsv } from "./csv";
import { checkEvent, ManualEventError } from "./manual";
import { CUSTOM, getEventType, specOf } from "./registers";
import { getObject, getObjectType, objectByExternalId, upsertObject, type UpsertStatus } from "./custom-objects";
import { getSettings, num } from "./settings";
import { parseDecimal, parseTimestamp, type Schema } from "./schema";

/** An object by id, or by its type and external id. */
export type ObjectRef = string | { type: string; externalId: string };

export interface CustomPushResult {
  accepted: number;
  rejected: { index: number; error: string }[];
  /** One per accepted message, in order: the object or event id and what happened to it. */
  results: { index: number; id: string; status: UpsertStatus | "duplicate" }[];
}

/**
 * sources.config.scope: the object the source works for. `link` names the link its objects use
 * to point at it; `also` lists the other object types it may write without that link (datasets).
 */
export interface SourceScope {
  link: string;
  id: string;
  also?: string[];
}

export const sourceScope = (source: Source): SourceScope | null => {
  const s = source.config.scope as Partial<SourceScope> | undefined;
  return s && typeof s.link === "string" && typeof s.id === "string" ? { link: s.link, id: s.id, also: Array.isArray(s.also) ? s.also.map(String) : [] } : null;
};

/** Who the audit names for what a source writes: no person, the source. */
export const sourceActor = (source: Source): Actor => ({ id: null, email: `source:${source.name}` });

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function resolve(db: TenantDb, ref: unknown, what: string): Promise<string> {
  if (typeof ref === "string") return ref;
  if (isObject(ref) && typeof ref.type === "string" && typeof ref.externalId === "string") {
    const o = await objectByExternalId(db, ref.type, ref.externalId);
    if (o) return o.id;
  }
  throw new ManualEventError(404, `${what}: object not found`);
}

async function pushObject(db: TenantDb, source: Source, scope: SourceScope | null, scopeType: string | null, m: RawMessage) {
  const type = String(m.type ?? "");
  if (!type.startsWith(`${CUSTOM}.`)) throw new ManualEventError(400, `unknown object type "${type}"`);
  const t = await getObjectType(db, type);
  if (!t) throw new ManualEventError(400, `unknown object type "${type}"`);
  for (const k of ["properties", "defaults", "links"] as const)
    if (m[k] !== undefined && !isObject(m[k])) throw new ManualEventError(400, `"${k}" must be an object`);
  const links: Record<string, string> = {};
  for (const [k, ref] of Object.entries((m.links as Record<string, unknown>) ?? {})) links[k] = await resolve(db, ref, `link "${k}"`);
  if (scope) {
    if (type === scopeType) throw new ManualEventError(403, "this source cannot change the object it works for");
    if (t.links[scope.link]) {
      if (links[scope.link] && links[scope.link] !== scope.id) throw new ManualEventError(403, `link "${scope.link}" is outside this source's scope`);
      links[scope.link] = scope.id;
    } else if (!scope.also?.includes(type)) throw new ManualEventError(403, `${type} is outside this source's scope`);
  }
  if (scope && t.links[scope.link]) {
    // an object already there that belongs to another project stays out of reach
    const prev = await objectByExternalId(db, type, String(m.externalId ?? ""));
    if (prev && prev.links[scope.link] && prev.links[scope.link] !== scope.id) throw new ManualEventError(403, "this object is outside this source's scope");
  }
  return upsertObject(db, sourceActor(source), {
    type, externalId: String(m.externalId ?? ""), name: typeof m.name === "string" ? m.name : null,
    properties: m.properties as Record<string, unknown> | undefined, defaults: m.defaults as Record<string, unknown> | undefined, links,
  });
}

async function pushEvent(db: TenantDb, source: Source, scope: SourceScope | null, m: RawMessage, now: Date) {
  const type = String(m.type ?? "");
  const key = typeof m.key === "string" ? m.key.trim() : "";
  if (!key || key.length > 200) throw new ManualEventError(400, "an event needs a key, the same each time it is sent");
  const t = type.startsWith(`${CUSTOM}.`) ? await getEventType(db, [], type) : null;
  if (!t) throw new ManualEventError(400, `unknown event type "${type}"`);
  if (m.payload !== undefined && !isObject(m.payload)) throw new ManualEventError(400, `"payload" must be an object`);
  if (!Array.isArray(m.objects)) throw new ManualEventError(400, `"objects" must be a list`);
  const objectIds: string[] = [];
  for (const ref of m.objects) objectIds.push(await resolve(db, ref, "objects"));
  if (scope && !objectIds.includes(scope.id)) throw new ManualEventError(403, "the event must be about the object this source works for");

  const known = await db.query<{ id: string }>(`select id from events where tenant_id = $1 and source_id = $2 and idempotency_key = $3`, [db.tenantId, source.id, key]);
  if (known.rows[0]) return { id: String(known.rows[0].id), status: "duplicate" as const };

  const ts = new Date(typeof m.ts === "string" || typeof m.ts === "number" ? m.ts : now);
  const payload = (m.payload as Record<string, unknown>) ?? {};
  const ids = await checkEvent(db, specOf(t, []), { ts, payload, objectIds });
  const { rows } = await db.query<{ id: string }>(
    `with e as (
       insert into events (tenant_id, ts, type, severity, payload, source_id, recorded_at, idempotency_key)
       values ($1, $2, $3, 'info', $4, $5, $6, $7)
       on conflict (tenant_id, source_id, idempotency_key) where idempotency_key is not null do nothing returning id
     )
     insert into event_objects (tenant_id, event_id, object_id)
     select $1, e.id, o from e, unnest($8::uuid[]) o returning event_id id`,
    [db.tenantId, ts, type, payload, source.id, now, key, ids],
  );
  if (!rows[0]) {
    // sent twice at the same moment: the other request stored it
    const again = await db.query<{ id: string }>(`select id from events where tenant_id = $1 and source_id = $2 and idempotency_key = $3`, [db.tenantId, source.id, key]);
    return { id: String(again.rows[0].id), status: "duplicate" as const };
  }
  const id = String(rows[0].id);
  await record(db, sourceActor(source), "event.create", { objectId: ids[0], subject: type, data: { event: Number(id), key, ts: ts.toISOString(), payload, objects: ids } });
  return { id, status: "created" as const };
}

/**
 * Messages of the source's tenant types, one by one: `{kind: "object", type, externalId, name?,
 * properties?, defaults?, links?}` or `{kind: "event", type, key, ts?, payload, objects}`, where
 * a link or an object is an id or `{type, externalId}`. A message refused does not stop the others.
 */
export async function ingestCustom(db: Db, source: Source, messages: RawMessage[], now = new Date()): Promise<CustomPushResult> {
  if (source.module !== CUSTOM) throw new ConnectorError(400, "source is not for custom types");
  const tdb = forTenant(db, source.tenant_id);
  const max = num(await getSettings(db), "ingest.max_batch", 500);
  if (messages.length > max) throw new ConnectorError(413, `too many messages (max ${max})`);
  await tdb.query(`insert into raw_inbox (tenant_id, source_id, received_at, body) values ($1, $2, $3, $4)`, [
    source.tenant_id, source.id, now, JSON.stringify({ custom: true, messages }),
  ]);

  const scope = sourceScope(source);
  const scoped = scope ? await getObject(tdb, scope.id) : null;
  if (scope && !scoped) throw new ConnectorError(409, "the object this source works for is gone");

  const out: CustomPushResult = { accepted: 0, rejected: [], results: [] };
  for (const [index, m] of messages.entries()) {
    try {
      const r = m.kind === "object" ? await pushObject(tdb, source, scope, scoped?.type ?? null, m)
        : m.kind === "event" ? await pushEvent(tdb, source, scope, m, now)
        : (() => { throw new ManualEventError(400, `"kind" must be "object" or "event"`); })();
      out.accepted++;
      out.results.push({ index, ...r });
    } catch (e) {
      if (!(e instanceof ManualEventError)) throw e;
      out.rejected.push({ index, error: e.message });
    }
  }
  return out;
}

// ---- documents ---------------------------------------------------------------------------------

export interface PushedFile {
  name: string;
  type?: string;
  bytes: Uint8Array;
}

const safeName = (name: string) => name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";

/**
 * A file (a plot, a report) kept on object storage and attached to one of the source's objects.
 * The same bytes sent again by the source are the same document: it is attached, not stored twice.
 */
export async function pushDocument(
  db: Db, store: ObjectStore, source: Source, file: PushedFile, object: ObjectRef, now = new Date(),
): Promise<{ documentId: string; objectId: string; status: "created" | "duplicate" }> {
  if (source.module !== CUSTOM) throw new ConnectorError(400, "source is not for custom types");
  const tdb = forTenant(db, source.tenant_id);
  const settings = await getSettings(db);
  const maxBytes = num(settings, "push.document_max_bytes", 3 * 1024 ** 2);
  const perDay = num(settings, "push.documents_per_day", 200);
  if (!file.bytes.length) throw new ConnectorError(400, "file is empty");
  if (file.bytes.length > maxBytes) throw new ConnectorError(413, `file too large (max ${maxBytes} bytes)`);

  let objectId: string;
  try {
    objectId = await resolve(tdb, object, "object");
  } catch (e) {
    throw e instanceof ManualEventError ? new ConnectorError(e.status, e.message) : e;
  }
  const target = await getObject(tdb, objectId);
  if (!target) throw new ConnectorError(404, "object: object not found");
  const scope = sourceScope(source);
  if (scope && target.id !== scope.id && target.links[scope.link] !== scope.id && !scope.also?.includes(target.type))
    throw new ConnectorError(403, "this object is outside this source's scope");

  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const attach = async (c: TenantDb, documentId: string) => {
    const linked = await c.query(
      `insert into document_objects (tenant_id, document_id, object_id) values ($1, $2, $3) on conflict do nothing`,
      [source.tenant_id, documentId, objectId],
    );
    if (linked.rowCount) await record(c, sourceActor(source), "document.attach", { objectId, subject: target.type, data: { document: documentId, filename: file.name, sha256 } });
  };
  const known = await tdb.query<{ id: string }>(`select id from documents where tenant_id = $1 and source_id = $2 and sha256 = $3`, [source.tenant_id, source.id, sha256]);
  if (known.rows[0]) {
    await attach(tdb, known.rows[0].id);
    return { documentId: known.rows[0].id, objectId, status: "duplicate" };
  }
  const { rows: day } = await tdb.query<{ n: number }>(
    `select count(*)::int n from documents where tenant_id = $1 and source_id = $2 and created_at > $3::timestamptz - interval '1 day'`,
    [source.tenant_id, source.id, now],
  );
  if (day[0].n >= perDay) throw new ConnectorError(429, `too many files (max ${perDay} per day)`);

  const key = `docs/${source.tenant_id}/${source.id}/${sha256}-${safeName(file.name)}`;
  const contentType = file.type || "application/octet-stream";
  if (await store.putNew(key, file.bytes, contentType)) await db.query(`select engine_count('r2.writes', 1, $1)`, [now]);
  const documentId = await inTransaction(db, async (connection) => {
    const c = forTenant(connection, source.tenant_id);
    const { rows } = await c.query<{ id: string }>(
      `insert into documents (tenant_id, storage_key, filename, content_type, size, sha256, metadata, source_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (source_id, sha256) where source_id is not null do nothing returning id`,
      [source.tenant_id, key, file.name, contentType, file.bytes.length, sha256, { kind: "push" }, source.id, now],
    );
    // the same file sent twice at once: the other request stored it
    const id = rows[0]?.id ?? (await c.query<{ id: string }>(`select id from documents where tenant_id = $1 and source_id = $2 and sha256 = $3`, [source.tenant_id, source.id, sha256])).rows[0].id;
    if (rows[0]) await record(c, sourceActor(source), "document.create", { objectId, subject: target.type, data: { document: id, filename: file.name, size: file.bytes.length, sha256 } });
    await attach(c, id);
    return id;
  });
  return { documentId: String(documentId), objectId, status: "created" };
}

// ---- CSV ----------------------------------------------------------------------------------------

function cell(spec: Schema[string] | undefined, raw: string): unknown {
  const v = raw.trim();
  switch (spec?.type) {
    case "number": case "integer": return parseDecimal(v) ?? v;
    case "boolean": return /^(true|1|yes|si|sì|vero)$/i.test(v) ? true : /^(false|0|no|falso)$/i.test(v) ? false : v;
    case "timestamp": return parseTimestamp(v) ?? v;
    case "quantity": {
      const [n, ...unit] = v.split(/\s+/);
      return parseDecimal(n) !== null && unit.length ? { value: parseDecimal(n), unit: unit.join(" ") } : v;
    }
    case "object": try { return JSON.parse(v); } catch { return v; }
    default: return v;
  }
}

/**
 * One object message per CSV row, for objects of `type`: `external_id` (required), `name`,
 * `link.<key>` (an id or the linked object's external id) and one column per property, with
 * `prop.sub` for a field inside an object property (a project's own result fields). Values are
 * read by their declared type; an empty cell leaves the property as it is. `default.<prop>`
 * columns only count when the object is new.
 */
export async function csvMessages(db: Db, source: Source, type: string, text: string): Promise<RawMessage[]> {
  const tdb = forTenant(db, source.tenant_id);
  const t = await getObjectType(tdb, type);
  if (!t) throw new ConnectorError(400, `unknown object type "${type}"`);
  const csv = parseCsv(text, num(await getSettings(db), "upload.max_rows", 5000), 200);
  if (!csv.headers.includes("external_id")) throw new ConnectorError(400, `the file needs an "external_id" column`);
  const scope = sourceScope(source);
  const schemas = new Map<string, Schema>();
  // the schema a "schemaFrom" property follows, from the object the row links to (or the scope's)
  const nestedSchema = async (prop: string, links: Record<string, string>): Promise<Schema> => {
    const from = t.properties[prop]?.schemaFrom;
    if (!from) return {};
    const [link, held] = from.split(".");
    const id = links[link] ?? (scope?.link === link ? scope.id : undefined);
    if (!id) return {};
    if (!schemas.has(`${id}.${held}`)) {
      const o = await getObject(tdb, id);
      schemas.set(`${id}.${held}`, (o?.properties[held] as Schema) ?? {});
    }
    return schemas.get(`${id}.${held}`)!;
  };

  const messages: RawMessage[] = [];
  for (const row of csv.rows) {
    const value = (h: string) => row[csv.headers.indexOf(h)] ?? "";
    const links: Record<string, string> = {};
    for (const h of csv.headers.filter((h) => h.startsWith("link.") && value(h).trim())) {
      const k = h.slice(5), v = value(h).trim();
      links[k] = /^[0-9a-f-]{36}$/i.test(v) || !t.links[k] ? v : (await objectByExternalId(tdb, t.links[k].type, v))?.id ?? v;
    }
    const properties: Record<string, unknown> = {}, defaults: Record<string, unknown> = {};
    for (const h of csv.headers) {
      const raw = value(h);
      if (!raw.trim() || h === "external_id" || h === "name" || h.startsWith("link.")) continue;
      const target = h.startsWith("default.") ? defaults : properties;
      const [prop, sub] = (h.startsWith("default.") ? h.slice(8) : h).split(".", 2);
      if (sub === undefined) target[prop] = cell(t.properties[prop], raw);
      else {
        const nested = (target[prop] ??= {}) as Record<string, unknown>;
        nested[sub] = cell((await nestedSchema(prop, links))[sub], raw);
      }
    }
    messages.push({ kind: "object", type, externalId: value("external_id"), ...(value("name").trim() ? { name: value("name").trim() } : {}), properties, defaults, links });
  }
  return messages;
}
