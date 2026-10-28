import { createHash } from "node:crypto";
import { forTenant, inTransaction, lockTenant, type Db, type TenantDb } from "./db";
import { documentsToday } from "./upload";
import type { ObjectStore } from "./store";
import { sniffType } from "./mime";
import { markSeen, type Source } from "./sources";
import type { Actor } from "./audit";
import { record } from "./audit";
import { ConnectorError, type RawMessage } from "./connectors";
import { parseCsv } from "./csv";
import { checkEvent, ManualEventError } from "./manual";
import { CUSTOM, getEventType, specOf } from "./registers";
import { getObject, getObjectType, objectByExternalId, upsertObject, type UpsertStatus } from "./custom-objects";
import { getSettings, num } from "./settings";
import { parseDecimal, parseTimestamp, type Schema } from "./schema";

export type ObjectRef = string | { type: string; externalId: string };

export interface CustomPushResult {
  accepted: number;
  rejected: { index: number; error: string }[];
  results: { index: number; id: string; status: UpsertStatus | "duplicate" }[];
}

export interface SourceScope {
  link: string;
  id: string;
  also?: string[];
}

export const sourceScope = (source: Source): SourceScope | null => {
  const s = source.config.scope as Partial<SourceScope> | undefined;
  return s && typeof s.link === "string" && typeof s.id === "string" ? { link: s.link, id: s.id, also: Array.isArray(s.also) ? s.also.map(String) : [] } : null;
};

export const sourceActor = (source: Source): Actor => ({ id: null, email: `source:${source.name}` });

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function safeKeys(v: unknown, what: string) {
  if (!isObject(v)) return;
  for (const k of Object.keys(v)) {
    if (UNSAFE_KEYS.has(k)) throw new ManualEventError(400, `${what}: "${k}" is not a valid key`);
    safeKeys(v[k], what);
  }
}

async function resolve(db: TenantDb, ref: unknown, what: string, scope: SourceScope | null = null): Promise<string> {
  const o = typeof ref === "string" ? (/^[0-9a-f-]{36}$/i.test(ref) ? await getObject(db, ref) : null)
    : isObject(ref) && typeof ref.type === "string" && typeof ref.externalId === "string" ? await objectByExternalId(db, ref.type, ref.externalId)
    : null;
  if (!o) throw new ManualEventError(404, `${what}: object not found`);
  if (scope && o.id !== scope.id && o.links[scope.link] !== scope.id && !scope.also?.includes(o.type))
    throw new ManualEventError(403, `${what}: object is outside this source's scope`);
  return o.id;
}

async function pushObject(db: TenantDb, source: Source, scope: SourceScope | null, scopeType: string | null, m: RawMessage) {
  const type = String(m.type ?? "");
  if (!type.startsWith(`${CUSTOM}.`)) throw new ManualEventError(400, `unknown object type "${type}"`);
  const t = await getObjectType(db, type);
  if (!t) throw new ManualEventError(400, `unknown object type "${type}"`);
  for (const k of ["properties", "defaults", "links"] as const) {
    if (m[k] !== undefined && !isObject(m[k])) throw new ManualEventError(400, `"${k}" must be an object`);
    safeKeys(m[k], `"${k}"`);
  }
  if (scope) {
    if (type === scopeType) throw new ManualEventError(403, "this source cannot change the object it works for");
    if (!t.links[scope.link]) throw new ManualEventError(403, `${type} is outside this source's scope`);
  }
  const links: Record<string, string> = Object.create(null);
  for (const [k, ref] of Object.entries((m.links as Record<string, unknown>) ?? {})) {
    if (scope && k === scope.link) {
      if (ref !== scope.id) throw new ManualEventError(403, `link "${scope.link}" is outside this source's scope`);
      continue;
    }
    links[k] = await resolve(db, ref, `link "${k}"`, scope);
  }
  if (scope) {
    links[scope.link] = scope.id;
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
  safeKeys(m.payload, `"payload"`);
  if (!Array.isArray(m.objects)) throw new ManualEventError(400, `"objects" must be a list`);
  const ts = new Date(typeof m.ts === "string" || typeof m.ts === "number" ? m.ts : now);
  if (Number.isNaN(ts.getTime())) throw new ManualEventError(400, "invalid event time");
  if (ts.getTime() - now.getTime() > num(await getSettings(db.shared), "ingest.max_future_s", 300) * 1000)
    throw new ManualEventError(400, "ts is in the future");
  const objectIds: string[] = [];
  for (const ref of m.objects) objectIds.push(await resolve(db, ref, "objects", scope));
  if (scope && !objectIds.includes(scope.id)) throw new ManualEventError(403, "the event must be about the object this source works for");

  const known = await db.query<{ id: string }>(`select id from events where tenant_id = $1 and source_id = $2 and idempotency_key = $3`, [db.tenantId, source.id, key]);
  if (known.rows[0]) return { id: String(known.rows[0].id), status: "duplicate" as const };

  const payload = (m.payload as Record<string, unknown>) ?? {};
  const ids = await checkEvent(db, specOf(t, []), { ts, payload, objectIds });
  const { rows } = await db.query<{ id: string }>(
    `with e as (
       insert into events (tenant_id, ts, type, severity, payload, source_id, recorded_at, idempotency_key)
       values ($1, $2, $3, 'info', $4, $5, $6, $7)
       on conflict (tenant_id, source_id, idempotency_key) where idempotency_key is not null do nothing returning id
     )
     insert into event_objects (tenant_id, event_id, object_id, pos)
     select $1, e.id, u.o, u.pos - 1 from e, unnest($8::uuid[]) with ordinality u(o, pos) returning event_id id`,
    [db.tenantId, ts, type, payload, source.id, now, key, ids],
  );
  if (!rows[0]) {
    const again = await db.query<{ id: string }>(`select id from events where tenant_id = $1 and source_id = $2 and idempotency_key = $3`, [db.tenantId, source.id, key]);
    return { id: String(again.rows[0].id), status: "duplicate" as const };
  }
  const id = String(rows[0].id);
  await record(db, sourceActor(source), "event.create", { objectId: ids[0], subject: type, data: { event: Number(id), key, ts: ts.toISOString(), payload, objects: ids } });
  return { id, status: "created" as const };
}

export async function ingestCustom(db: Db, source: Source, messages: RawMessage[], now = new Date()): Promise<CustomPushResult> {
  if (source.module !== CUSTOM) throw new ConnectorError(400, "source is not for custom types");
  const tdb = forTenant(db, source.tenant_id);
  const max = num(await getSettings(db), "ingest.max_batch", 500);
  if (messages.length > max) throw new ConnectorError(413, `too many messages (max ${max})`);
  await tdb.query(`insert into raw_inbox (tenant_id, source_id, received_at, body) values ($1, $2, $3, $4)`, [
    source.tenant_id, source.id, now, JSON.stringify({ custom: true, messages }),
  ]);

  const scope = sourceScope(source);
  const out: CustomPushResult = { accepted: 0, rejected: [], results: [] };
  await inTransaction(db, async (connection) => {
    const c = forTenant(connection, source.tenant_id);
    const scoped = scope ? await getObject(c, scope.id)
      : (await c.query(`select 1 from sources where tenant_id = $1 and id = $2`, [source.tenant_id, source.id]), null);
    if (scope && !scoped) throw new ConnectorError(409, "the object this source works for is gone");
    for (const [index, m] of messages.entries()) {
      await connection.query("savepoint message");
      try {
        const r = m.kind === "object" ? await pushObject(c, source, scope, scoped?.type ?? null, m)
          : m.kind === "event" ? await pushEvent(c, source, scope, m, now)
          : (() => { throw new ManualEventError(400, `"kind" must be "object" or "event"`); })();
        await connection.query("release savepoint message");
        out.accepted++;
        out.results.push({ index, ...r });
      } catch (e) {
        if (!(e instanceof ManualEventError)) throw e;
        await connection.query("rollback to savepoint message");
        out.rejected.push({ index, error: e.message });
      }
    }
  });
  await markSeen(db, source, out.rejected.length ? `${out.rejected.length} rejected: ${out.rejected[0].error}` : null, now);
  return out;
}

export interface PushedFile {
  name: string;
  type?: string;
  bytes: Uint8Array;
}

const safeName = (name: string) => name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";

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
    objectId = await resolve(tdb, object, "object", sourceScope(source));
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
  if ((await documentsToday(tdb, source, now)) >= perDay) throw new ConnectorError(429, `too many files (max ${perDay} per day)`);

  const key = `docs/${source.tenant_id}/${source.id}/${sha256}-${safeName(file.name)}`;
  const contentType = sniffType(file.bytes, file.type);
  if (await store.putNew(key, file.bytes, contentType)) await db.query(`select engine_count('r2.writes', 1, $1)`, [now]);
  const documentId = await inTransaction(db, async (connection) => {
    const c = forTenant(connection, source.tenant_id);
    await lockTenant(connection, source.tenant_id, `documents:${source.id}`);
    const same = await c.query<{ id: string }>(`select id from documents where tenant_id = $1 and source_id = $2 and sha256 = $3`, [source.tenant_id, source.id, sha256]);
    if (!same.rows[0] && (await documentsToday(c, source, now)) >= perDay) throw new ConnectorError(429, `too many files (max ${perDay} per day)`);
    const { rows } = await c.query<{ id: string }>(
      `insert into documents (tenant_id, storage_key, filename, content_type, size, sha256, metadata, source_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (source_id, sha256) where source_id is not null do nothing returning id`,
      [source.tenant_id, key, file.name, contentType, file.bytes.length, sha256, { kind: "push" }, source.id, now],
    );
    const id = rows[0]?.id ?? (await c.query<{ id: string }>(`select id from documents where tenant_id = $1 and source_id = $2 and sha256 = $3`, [source.tenant_id, source.id, sha256])).rows[0].id;
    if (rows[0]) await record(c, sourceActor(source), "document.create", { objectId, subject: target.type, data: { document: id, filename: file.name, size: file.bytes.length, sha256 } });
    await attach(c, id);
    return id;
  });
  return { documentId: String(documentId), objectId, status: "created" };
}

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

export async function csvMessages(db: Db, source: Source, type: string, text: string): Promise<RawMessage[]> {
  const tdb = forTenant(db, source.tenant_id);
  const t = await getObjectType(tdb, type);
  if (!t) throw new ConnectorError(400, `unknown object type "${type}"`);
  const csv = parseCsv(text, num(await getSettings(db), "upload.max_rows", 5000), 200);
  if (!csv.headers.includes("external_id")) throw new ConnectorError(400, `the file needs an "external_id" column`);
  const unsafe = csv.headers.find((h) => h.split(".").some((part) => UNSAFE_KEYS.has(part)));
  if (unsafe) throw new ConnectorError(400, `"${unsafe}" is not a valid column`);
  const scope = sourceScope(source);
  const schemas = new Map<string, Schema>();
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
    const links: Record<string, string> = Object.create(null);
    for (const h of csv.headers.filter((h) => h.startsWith("link.") && value(h).trim())) {
      const k = h.slice(5), v = value(h).trim();
      links[k] = /^[0-9a-f-]{36}$/i.test(v) || !t.links[k] ? v : (await objectByExternalId(tdb, t.links[k].type, v))?.id ?? v;
    }
    const properties: Record<string, unknown> = Object.create(null), defaults: Record<string, unknown> = Object.create(null);
    for (const h of csv.headers) {
      const raw = value(h);
      if (!raw.trim() || h === "external_id" || h === "name" || h.startsWith("link.")) continue;
      const target = h.startsWith("default.") ? defaults : properties;
      const [prop, sub] = (h.startsWith("default.") ? h.slice(8) : h).split(".", 2);
      if (sub === undefined) target[prop] = cell(t.properties[prop], raw);
      else {
        const nested = (target[prop] ??= Object.create(null)) as Record<string, unknown>;
        nested[sub] = cell((await nestedSchema(prop, links))[sub], raw);
      }
    }
    messages.push({ kind: "object", type, externalId: value("external_id"), ...(value("name").trim() ? { name: value("name").trim() } : {}), properties, defaults, links });
  }
  return messages;
}
