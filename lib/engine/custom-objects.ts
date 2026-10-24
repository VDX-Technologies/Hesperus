// Object types made by the tenant in the schema editor (module "custom") and their objects:
// a research project, a dataset, a result, or anything else a sector needs, with no code of its
// own. A type has a field schema (the same one event types use) and declared links to other
// types; the database checks both again (objects_validate, objects_validate_schemas,
// links_validate_declared), this file checks first so people get readable errors.
// Two schema features let a parent shape its children without a new type per project:
//   format "schema"   an object property that holds a field schema (a project's result fields)
//   schemaFrom        a property checked against that schema, read through a declared link
import type { Db, TenantDb } from "./db";
import { forTenant, inTransaction } from "./db";
import type { PropertySpec } from "./package";
import { canRecord, ManualEventError, type Author } from "./manual";
import { record, type Actor } from "./audit";
import { getSettings, num } from "./settings";
import { checkFields, KEY, validateProperties, type Schema } from "./schema";
import { CUSTOM, FIELD_TYPES, filterable } from "./registers";

export interface LinkSpec {
  /** Target object type, "custom.project" or a package type such as "core.site". */
  type: string;
  required?: boolean;
  label?: Record<string, string>;
}

export interface ObjectTypeInfo {
  /** "custom.project" */
  type: string;
  module: string;
  key: string;
  name: Record<string, string>;
  properties: Schema;
  links: Record<string, LinkSpec>;
}

export interface ObjectTypeInput {
  key: string;
  name: Record<string, string>;
  properties: Schema;
  links?: Record<string, LinkSpec>;
}

export interface CustomObject {
  id: string;
  type: string;
  name: string;
  externalId: string | null;
  properties: Record<string, unknown>;
  /** Declared links: key → target object id. */
  links: Record<string, string>;
  createdAt: Date;
}

const TYPE = /^[a-z][a-z0-9_]{0,39}\.[a-z][a-z0-9_]{0,39}$/;
const UUID = /^[0-9a-f-]{36}$/i;
// links the places tree uses; an object type cannot declare them
const RESERVED_LINKS = ["part_of", "located_in"];

/** The properties in the editor's order. */
const ordered = (props: Schema, order: string[] | null): Schema =>
  Object.fromEntries([...(order ?? []).filter((k) => k in props), ...Object.keys(props).filter((k) => !order?.includes(k))].map((k) => [k, props[k]]));

type TypeRow = { key: string; name: Record<string, string>; properties: Schema; links: Record<string, LinkSpec>; field_order: string[] | null };
const typeInfo = (r: TypeRow): ObjectTypeInfo => ({
  type: `${CUSTOM}.${r.key}`, module: CUSTOM, key: r.key, name: r.name, properties: ordered(r.properties, r.field_order), links: r.links ?? {},
});

/** The tenant's own object types, by name. */
export async function listObjectTypes(db: TenantDb): Promise<ObjectTypeInfo[]> {
  const { rows } = await db.query<TypeRow>(
    `select key, name, properties, links, field_order from object_types where tenant_id = $1 and module = $2 order by name->>'en', key`,
    [db.tenantId, CUSTOM],
  );
  return rows.map(typeInfo);
}

export async function getObjectType(db: TenantDb, type: string): Promise<ObjectTypeInfo | null> {
  if (!type.startsWith(`${CUSTOM}.`)) return null;
  const { rows } = await db.query<TypeRow>(
    `select key, name, properties, links, field_order from object_types where tenant_id = $1 and module = $2 and key = $3`,
    [db.tenantId, CUSTOM, type.slice(CUSTOM.length + 1)],
  );
  return rows[0] ? typeInfo(rows[0]) : null;
}

/** Properties of a type the tenant can see (its own or a global one), null when it does not exist. */
async function typeProperties(db: TenantDb, type: string): Promise<Schema | null> {
  const { rows } = await db.query<{ properties: Schema }>(
    `select properties from object_types where (tenant_id = $1 or tenant_id is null) and module || '.' || key = $2
      order by tenant_id nulls last limit 1`,
    [db.tenantId, type],
  );
  return rows[0]?.properties ?? null;
}

/** Problems of a type definition that need no database, null when fine. */
export function checkObjectType(input: ObjectTypeInput): string | null {
  if (!KEY.test(input.key)) return "invalid key";
  if (!Object.values(input.name ?? {}).some((n) => n?.trim())) return "a name is required";
  const err = checkFields(input.properties, FIELD_TYPES);
  if (err) return err;
  const links = Object.entries(input.links ?? {});
  if (links.length > 10) return "too many links";
  for (const [k, l] of links) {
    if (!KEY.test(k) || RESERVED_LINKS.includes(k)) return `invalid link key "${k}"`;
    if (!TYPE.test(l?.type ?? "")) return `invalid type for link "${k}"`;
  }
  for (const [k, s] of Object.entries(input.properties)) {
    if ((s.format === "schema" || s.schemaFrom) && s.type !== "object") return `"${k}": only object properties hold or follow a schema`;
    if (s.format === "text" && s.type !== "string") return `"${k}": only string properties are written on several lines`;
    if (s.format && s.format !== "schema" && s.format !== "text") return `"${k}": unknown format`;
    if (s.format && s.schemaFrom) return `"${k}": a property holds a schema or follows one, not both`;
    if (s.schemaFrom) {
      const [link, prop] = s.schemaFrom.split(".");
      if (!input.links?.[link] || !prop) return `"${k}": schemaFrom must be "<link>.<property>" of a declared link`;
    }
  }
  return null;
}

/** Creates or replaces an object type of the tenant. Only the owner; objects already saved stay as they are. */
export async function saveObjectType(db: TenantDb, author: Author, input: ObjectTypeInput): Promise<string> {
  if (author.role !== "owner") throw new ManualEventError(403, "only the owner manages object types");
  const err = checkObjectType(input);
  if (err) throw new ManualEventError(400, err);
  const type = `${CUSTOM}.${input.key}`;
  // targets must exist; a link to the type itself (a result refining another) is fine
  for (const [k, l] of Object.entries(input.links ?? {})) {
    const target = l.type === type ? input.properties : await typeProperties(db, l.type);
    if (!target) throw new ManualEventError(400, `link "${k}": unknown type "${l.type}"`);
    for (const [p, s] of Object.entries(input.properties)) {
      if (!s.schemaFrom?.startsWith(`${k}.`)) continue;
      const held = target[s.schemaFrom.slice(k.length + 1)];
      if (held?.format !== "schema") throw new ManualEventError(400, `"${p}": ${l.type} has no schema property "${s.schemaFrom.slice(k.length + 1)}"`);
    }
  }
  const { rows: existing } = await db.query(`select 1 from object_types where tenant_id = $1 and module = $2 and key = $3`, [db.tenantId, CUSTOM, input.key]);
  if (!existing.length) {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int n from object_types where tenant_id = $1`, [db.tenantId]);
    if (rows[0].n >= num(await getSettings(db.shared), "registers.object_types_max", 30)) throw new ManualEventError(429, "object type limit reached");
  }
  const links = Object.fromEntries(Object.entries(input.links ?? {}).map(([k, l]) => [k, { type: l.type, ...(l.required ? { required: true } : {}), ...(l.label ? { label: l.label } : {}) }]));
  await db.query(
    `insert into object_types (tenant_id, module, key, name, properties, links, field_order) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tenant_id, module, key) where tenant_id is not null
     do update set name = excluded.name, properties = excluded.properties, links = excluded.links, field_order = excluded.field_order`,
    [db.tenantId, CUSTOM, input.key, input.name, input.properties, links, Object.keys(input.properties)],
  );
  await record(db, author, existing.length ? "object_type.update" : "object_type.create", { subject: type, data: { ...input, links } });
  return type;
}

// ---- objects ---------------------------------------------------------------------------------

/** Database refusals as the errors people see: the triggers check what this file checks, and more. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; message: string };
    if (err.code === "23505") throw new ManualEventError(409, "an object with this id already exists");
    if (err.code === "23514") throw new ManualEventError(400, err.message.replace(/^invalid properties for [\w.]+: /, ""));
    throw e;
  }
}

/** Schemas held by the object (format "schema") and the ones it follows through its links. */
async function checkProperties(db: TenantDb, t: ObjectTypeInfo, properties: Record<string, unknown>, links: Record<string, string>) {
  const err = validateProperties(t.properties, properties);
  if (err) throw new ManualEventError(400, err);
  for (const [k, s] of Object.entries(t.properties)) {
    const v = properties[k];
    if (v === undefined || v === null) continue;
    if (s.format === "schema") {
      const bad = checkFields(v as Schema, FIELD_TYPES);
      if (bad) throw new ManualEventError(400, `property "${k}": ${bad}`);
    }
    if (s.schemaFrom) {
      const [link, prop] = s.schemaFrom.split(".");
      if (!links[link]) continue;
      const { rows } = await db.query<{ schema: Schema | null }>(`select properties->$3 schema from objects where tenant_id = $1 and id = $2`, [db.tenantId, links[link], prop]);
      const bad = validateProperties(rows[0]?.schema ?? {}, v);
      if (bad) throw new ManualEventError(400, `property "${k}": ${bad}`);
    }
  }
}

/** Declared links: required ones present, each to an object of the declared type. */
async function checkLinks(db: TenantDb, t: ObjectTypeInfo, links: Record<string, string>) {
  for (const k of Object.keys(links)) if (!t.links[k]) throw new ManualEventError(400, `link "${k}" is not declared by ${t.type}`);
  for (const [k, l] of Object.entries(t.links)) {
    const dst = links[k];
    if (!dst) {
      if (l.required) throw new ManualEventError(400, `link "${k}" is required`);
      continue;
    }
    if (!UUID.test(dst)) throw new ManualEventError(404, `link "${k}": object not found`);
    const { rows } = await db.query<{ type: string }>(
      `select t.module || '.' || t.key type from objects o join object_types t on t.id = o.type_id where o.tenant_id = $1 and o.id = $2`,
      [db.tenantId, dst],
    );
    if (!rows[0]) throw new ManualEventError(404, `link "${k}": object not found`);
    if (rows[0].type !== l.type) throw new ManualEventError(400, `link "${k}" must point to ${l.type}`);
  }
}

async function objectLimit(db: TenantDb) {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int n from objects o where o.tenant_id = $1 and o.type_id in (select id from object_types where tenant_id = $1 and module = $2)`,
    [db.tenantId, CUSTOM],
  );
  if (rows[0].n >= num(await getSettings(db.shared), "custom.objects_max", 5000)) throw new ManualEventError(429, "object limit reached");
}

const scoped = (db: TenantDb, c: Db) => forTenant(c, db.tenantId);

/** Creates an object of a custom type with its links, in one transaction. Returns its id. */
export async function createObject(
  db: TenantDb,
  author: Author,
  input: { type: string; name: string; externalId?: string | null; properties: Record<string, unknown>; links?: Record<string, string> },
): Promise<string> {
  if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot create objects");
  const t = await getObjectType(db, input.type);
  if (!t) throw new ManualEventError(400, `unknown object type "${input.type}"`);
  const name = input.name?.trim();
  if (!name) throw new ManualEventError(400, "a name is required");
  const links = input.links ?? {};
  await checkLinks(db, t, links);
  await checkProperties(db, t, input.properties, links);
  await objectLimit(db);
  const id = await insertObject(db, t, input.externalId ?? null, name, input.properties, links);
  await record(db, author, "object.create", { objectId: id, subject: name, data: { type: t.type, externalId: input.externalId ?? null, properties: input.properties, links } });
  return id;
}

async function insertObject(db: TenantDb, t: ObjectTypeInfo, externalId: string | null, name: string, properties: Record<string, unknown>, links: Record<string, string>) {
  return guarded(() =>
    inTransaction(db.shared, async (c) => {
      const tdb = scoped(db, c);
      const { rows } = await tdb.query<{ id: string }>(
        `insert into objects (tenant_id, type_id, external_id, name, properties)
         select $1, id, $3, $4, $5 from object_types where tenant_id = $1 and module = $2 and key = $6 returning id`,
        [db.tenantId, CUSTOM, externalId, name, properties, t.key],
      );
      for (const [k, dst] of Object.entries(links))
        await tdb.query(`insert into links (tenant_id, type, src_id, dst_id) values ($1, $2, $3, $4)`, [db.tenantId, k, rows[0].id, dst]);
      return rows[0].id;
    }),
  );
}

/** The same JSON value, whatever the key order. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

const withPatch = (base: Record<string, unknown>, patch: Record<string, unknown>) => {
  const next = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  return next;
};

export type UpsertStatus = "created" | "updated" | "unchanged";

/**
 * Creates the object of `type` with this external id, or changes the one already there: for
 * machines that send the same objects again (a pipeline run after run). `properties` and
 * `links` are applied each time (null removes a property); `defaults` only when the object is
 * created, so what people changed since (a review status) stays. Nothing is written, nor
 * audited, when nothing changes. The caller has authorized the writer (a source token).
 */
export async function upsertObject(
  db: TenantDb,
  actor: Actor,
  input: {
    type: string; externalId: string; name?: string | null;
    properties?: Record<string, unknown>; defaults?: Record<string, unknown>; links?: Record<string, string>;
  },
): Promise<{ id: string; status: UpsertStatus }> {
  const t = await getObjectType(db, input.type);
  if (!t) throw new ManualEventError(400, `unknown object type "${input.type}"`);
  const externalId = input.externalId?.trim();
  if (!externalId || externalId.length > 200) throw new ManualEventError(400, "an external id is required");
  const { rows } = await db.query<{ id: string }>(
    `select o.id from objects o join object_types t on t.id = o.type_id
      where o.tenant_id = $1 and t.tenant_id = $1 and t.module = $2 and t.key = $3 and o.external_id = $4`,
    [db.tenantId, CUSTOM, t.key, externalId],
  );
  const prev = rows[0] ? await getObject(db, rows[0].id) : null;
  const name = input.name?.trim() || prev?.name || externalId;
  const properties = withPatch(prev ? prev.properties : withPatch({}, input.defaults ?? {}), input.properties ?? {});
  const links = { ...prev?.links, ...input.links };
  await checkLinks(db, t, links);
  await checkProperties(db, t, properties, links);

  if (!prev) {
    await objectLimit(db);
    const id = await insertObject(db, t, externalId, name, properties, links);
    await record(db, actor, "object.create", { objectId: id, subject: name, data: { type: t.type, externalId, properties, links } });
    return { id, status: "created" };
  }
  const changedLinks = Object.keys(links).filter((k) => links[k] !== prev.links[k]);
  if (name === prev.name && same(properties, prev.properties) && !changedLinks.length) return { id: prev.id, status: "unchanged" };
  await guarded(() =>
    inTransaction(db.shared, async (c) => {
      const tdb = scoped(db, c);
      await tdb.query(`update objects set name = $3, properties = $4 where tenant_id = $1 and id = $2`, [db.tenantId, prev.id, name, properties]);
      for (const k of changedLinks) {
        await tdb.query(`delete from links where tenant_id = $1 and src_id = $2 and type = $3`, [db.tenantId, prev.id, k]);
        await tdb.query(`insert into links (tenant_id, type, src_id, dst_id) values ($1, $2, $3, $4)`, [db.tenantId, k, prev.id, links[k]]);
      }
    }),
  );
  const keys = [...new Set([...Object.keys(prev.properties), ...Object.keys(properties)])].filter((k) => !same(prev.properties[k], properties[k]));
  await record(db, actor, "object.update", {
    objectId: prev.id, subject: name,
    data: {
      type: t.type, externalId,
      changed: Object.fromEntries(keys.map((k) => [k, { before: prev.properties[k] ?? null, after: properties[k] ?? null }])),
      ...(changedLinks.length ? { links: Object.fromEntries(changedLinks.map((k) => [k, { before: prev.links[k] ?? null, after: links[k] }])) } : {}),
      ...(name !== prev.name ? { rename: { before: prev.name, after: name } } : {}),
    },
  });
  return { id: prev.id, status: "updated" };
}

/** The object of a custom type with this external id, null when there is none. */
export async function objectByExternalId(db: TenantDb, type: string, externalId: string): Promise<CustomObject | null> {
  if (!type.startsWith(`${CUSTOM}.`)) return null;
  const { rows } = await db.query<ObjectRow>(`${SELECT_OBJECTS} and t.key = $4 and o.external_id = $5`, [db.tenantId, RESERVED_LINKS, CUSTOM, type.slice(CUSTOM.length + 1), externalId]);
  return rows[0] ? toObject(rows[0]) : null;
}

type ObjectRow = { id: string; key: string; name: string | null; external_id: string | null; properties: Record<string, unknown>; created_at: Date; links: Record<string, string> | null };

// $1 tenant, $2 reserved links, $3 module; the caller adds its own conditions from $4
const SELECT_OBJECTS = `select o.id, t.key, o.name, o.external_id, o.properties, o.created_at,
        (select jsonb_object_agg(l.type, l.dst_id) from links l where l.tenant_id = $1 and l.src_id = o.id and l.type <> all($2::text[])) links
   from objects o join object_types t on t.id = o.type_id
  where o.tenant_id = $1 and t.tenant_id = $1 and t.module = $3`;

const toObject = (r: ObjectRow): CustomObject => ({
  id: r.id, type: `${CUSTOM}.${r.key}`, name: r.name ?? r.external_id ?? r.id.slice(0, 8), externalId: r.external_id,
  properties: r.properties ?? {}, links: r.links ?? {}, createdAt: r.created_at,
});

/** One object of a custom type with its declared links, null when it is not there. */
export async function getObject(db: TenantDb, id: string): Promise<CustomObject | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<ObjectRow>(`${SELECT_OBJECTS} and o.id = $4`, [db.tenantId, RESERVED_LINKS, CUSTOM, id]);
  return rows[0] ? toObject(rows[0]) : null;
}

/** Objects of one custom type, optionally only those linked to `linkedTo.id` through `linkedTo.key`. */
export async function listObjects(
  db: TenantDb,
  type: string,
  opts: { linkedTo?: { key: string; id: string }; limit?: number } = {},
): Promise<CustomObject[]> {
  return (await searchObjects(db, type, { linkedTo: opts.linkedTo, limit: Math.min(opts.limit ?? 500, 2000) })).objects;
}

export interface ObjectSearch {
  linkedTo?: { key: string; id: string };
  /** words the name or the external id contains, case insensitive */
  text?: string;
  /** property → value it must hold (string, number, integer or boolean properties) */
  where?: Record<string, unknown>;
  /** property → lowest / highest value (number or integer properties) */
  min?: Record<string, number>;
  max?: Record<string, number>;
  /** a number, integer or string property, "name", or "created" (the default, newest first) */
  order?: { by: string; desc?: boolean };
  /**
   * The fields inside object properties, which the type does not declare (a schema taken from a
   * linked object): with them, "extra.tic_id" can be filtered and sorted on like a property.
   */
  schemas?: Record<string, Schema>;
  limit?: number;
  offset?: number;
}

const numeric = (s: PropertySpec | undefined) => s?.type === "number" || s?.type === "integer";

/**
 * The objects of one custom type a search matches, as a query and its parameters (`where`, with
 * the columns of SELECT_OBJECTS) and the property paths it can read, shared by the page of objects
 * and the aggregates over them. Null when nothing can match.
 */
async function filtered(db: TenantDb, type: string, q: ObjectSearch) {
  const t = await getObjectType(db, type);
  if (!t || t.module !== CUSTOM) return null;
  const link = q.linkedTo && UUID.test(q.linkedTo.id) ? q.linkedTo : null;
  if (q.linkedTo && !link) return null;
  const params: unknown[] = [db.tenantId, RESERVED_LINKS, CUSTOM, t.key];
  const p = (v: unknown) => `$${params.push(v)}`;
  // a declared property, or a field of an object property: its spec and its jsonb / text path
  const at = (k: string) => {
    const [top, sub, ...rest] = k.split(".");
    const outer = t.properties[top];
    if (sub === undefined) return outer ? { spec: outer, json: () => `o.properties->${p(top)}`, text: () => `o.properties->>${p(top)}` } : null;
    const spec = outer?.type === "object" && !rest.length ? q.schemas?.[top]?.[sub] : undefined;
    return spec ? { spec, json: () => `o.properties->${p(top)}->${p(sub)}`, text: () => `o.properties->${p(top)}->>${p(sub)}` } : null;
  };
  const numberAt = (f: NonNullable<ReturnType<typeof at>>) => `case when jsonb_typeof(${f.json()}) = 'number' then (${f.text()})::numeric end`;
  const conds: string[] = [];
  if (link) conds.push(`exists (select 1 from links l where l.tenant_id = $1 and l.src_id = o.id and l.type = ${p(link.key)} and l.dst_id = ${p(link.id)}::uuid)`);
  const text = q.text?.trim();
  if (text) {
    const like = p(`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    conds.push(`(o.name ilike ${like} or o.external_id ilike ${like})`);
  }
  for (const [k, v] of Object.entries(q.where ?? {})) {
    const f = at(k);
    if (v === undefined || v === null || v === "" || !f || !filterable(f.spec)) continue;
    conds.push(`${f.json()} = ${p(JSON.stringify(v))}::jsonb`);
  }
  for (const [bound, op] of [[q.min, ">="], [q.max, "<="]] as const) {
    for (const [k, v] of Object.entries(bound ?? {})) {
      const f = at(k);
      if (Number.isFinite(v) && f && numeric(f.spec)) conds.push(`${numberAt(f)} ${op} ${p(v)}`);
    }
  }
  const where = `${SELECT_OBJECTS} and t.key = $4${conds.map((c) => ` and ${c}`).join("")}`;
  // a numeric property, read from the rows of `where` taken as `o`
  const numberOf = (k: string) => {
    const f = at(k);
    return f && numeric(f.spec) ? numberAt(f) : null;
  };
  return { params, p, at, numberAt, numberOf, where };
}

/**
 * A page of the objects of one custom type, filtered on their properties, with the number of
 * objects that match. Only properties declared by the type (or by `schemas`, one level down) can
 * be filtered or sorted on; others are ignored, so a stale link never breaks the page. Objects
 * missing the sort property come last.
 */
export async function searchObjects(db: TenantDb, type: string, q: ObjectSearch = {}): Promise<{ objects: CustomObject[]; total: number }> {
  const s = await filtered(db, type, q);
  if (!s) return { objects: [], total: 0 };
  const { params, p, at, numberAt, where } = s;
  const countParams = [...params];
  const by = q.order?.by ?? "";
  const dir = q.order?.desc ? "desc" : "asc";
  const f = at(by);
  const order = f && numeric(f.spec) ? `${numberAt(f)} ${dir} nulls last, o.created_at desc`
    : f && f.spec.type === "string" ? `${f.text()} ${dir} nulls last, o.created_at desc`
    : by === "name" ? `coalesce(o.name, o.external_id) ${dir} nulls last, o.created_at desc`
    : `o.created_at ${by === "created" && !q.order?.desc ? "asc" : "desc"}`;
  const limit = Math.max(0, Math.min(q.limit ?? num(await getSettings(db.shared), "objects.page_size", 100), 2000));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const [{ rows }, count] = await Promise.all([
    db.query<ObjectRow>(`${where} order by ${order}, o.id limit ${p(limit)} offset ${p(offset)}`, params),
    db.query<{ n: number }>(`select count(*)::int n from (${where}) x`, countParams),
  ]);
  return { objects: rows.map(toObject), total: count.rows[0].n };
}

export interface Histogram {
  /** the lowest and highest value among the matching objects; null when none holds a number */
  min: number | null;
  max: number | null;
  /** equal-width bins from min to max, the last one closed: [lo, hi) … [lo, hi] */
  bins: { lo: number; hi: number; n: number }[];
}

/**
 * How the values of one numeric property spread over the objects a search matches, in `bins`
 * equal-width bins (at most 100); objects without a number there are left out.
 */
export async function objectHistogram(db: TenantDb, type: string, key: string, q: ObjectSearch = {}, bins = 20): Promise<Histogram> {
  const none: Histogram = { min: null, max: null, bins: [] };
  const s = await filtered(db, type, q);
  const value = s?.numberOf(key);
  if (!s || !value) return none;
  const k = Math.max(1, Math.min(Math.floor(bins), 100));
  const kp = s.p(k);
  const { rows } = await db.query<{ lo: number; hi: number; b: number; n: number }>(`with v as (select ${value} v from (${s.where}) o), r as (select min(v) lo, max(v) hi from v)
    select r.lo::float8 lo, r.hi::float8 hi,
           case when r.hi = r.lo then 1 else least(width_bucket(v.v, r.lo, r.hi, ${kp}::int), ${kp}::int) end b, count(*)::int n
      from v, r where v.v is not null group by 1, 2, 3 order by 3`, s.params);
  if (!rows.length) return none;
  const { lo, hi } = rows[0];
  const n = hi === lo ? 1 : k;
  const width = (hi - lo) / n;
  const counts = new Map(rows.map((r) => [r.b, r.n]));
  return {
    min: lo, max: hi,
    bins: Array.from({ length: n }, (_, i) => ({ lo: lo + i * width, hi: i === n - 1 ? hi : lo + (i + 1) * width, n: counts.get(i + 1) ?? 0 })),
  };
}

/**
 * Two numeric properties of the objects a search matches, as points to plot (those holding a
 * number in both), at most `limit` of them (2000 at most), with how many there are in all.
 */
export async function objectPoints(
  db: TenantDb, type: string, x: string, y: string, q: ObjectSearch = {}, limit = 1000,
): Promise<{ points: { id: string; name: string; x: number; y: number }[]; total: number }> {
  const s = await filtered(db, type, q);
  const vx = s?.numberOf(x);
  const vy = s?.numberOf(y);
  if (!s || !vx || !vy) return { points: [], total: 0 };
  const cap = Math.max(1, Math.min(Math.floor(limit), 2000));
  const { rows } = await db.query<{ id: string; name: string; x: number; y: number; total: number }>(
    `select id, name, x, y, count(*) over ()::int total from (
       select o.id, coalesce(o.name, o.external_id, left(o.id::text, 8)) name, (${vx})::float8 x, (${vy})::float8 y from (${s.where}) o
     ) p where x is not null and y is not null order by id limit ${s.p(cap)}`,
    s.params,
  );
  return { points: rows.map(({ total: _, ...p }) => p), total: rows[0]?.total ?? 0 };
}

/**
 * How many objects of a type each object is linked to through `link`, split by the value of
 * one property when `by` is given: the results of every project, per review status. With
 * `since`, only the objects created from then on.
 */
export async function countLinked(db: TenantDb, type: string, link: string, by?: string, since?: Date): Promise<{ id: string; value: string | null; n: number }[]> {
  if (!type.startsWith(`${CUSTOM}.`)) return [];
  const { rows } = await db.query<{ id: string; value: string | null; n: number }>(
    `select l.dst_id id, case when $5::text is null then null else o.properties->>$5 end value, count(*)::int n
       from objects o join object_types t on t.id = o.type_id
       join links l on l.tenant_id = $1 and l.src_id = o.id and l.type = $4
      where o.tenant_id = $1 and t.tenant_id = $1 and t.module = $2 and t.key = $3
        and ($6::timestamptz is null or o.created_at >= $6)
      group by 1, 2`,
    [db.tenantId, CUSTOM, type.slice(CUSTOM.length + 1), link, by ?? null, since ?? null],
  );
  return rows;
}

export interface ObjectDocument {
  id: string;
  filename: string;
  contentType: string | null;
  size: number | null;
  createdAt: Date;
}

/** The files attached to an object (plots, reports), newest first. */
export async function objectDocuments(db: TenantDb, objectId: string): Promise<ObjectDocument[]> {
  if (!UUID.test(objectId)) return [];
  const { rows } = await db.query<{ id: string; filename: string; content_type: string | null; size: string | null; created_at: Date }>(
    `select d.id, d.filename, d.content_type, d.size, d.created_at
       from document_objects x join documents d on d.id = x.document_id and d.tenant_id = $1
      where x.tenant_id = $1 and x.object_id = $2
      order by d.created_at desc, d.id limit 200`,
    [db.tenantId, objectId],
  );
  return rows.map((r) => ({ id: r.id, filename: r.filename, contentType: r.content_type, size: r.size === null ? null : Number(r.size), createdAt: r.created_at }));
}

async function found(db: TenantDb, id: string) {
  const o = await getObject(db, id);
  if (!o) throw new ManualEventError(404, "object not found");
  const t = (await getObjectType(db, o.type))!;
  return { o, t };
}

/**
 * Changes some properties (a review status, a note), keeping the others: a null value removes
 * the property. `name` renames. Validated against the type and the schemas it follows.
 */
export async function updateObject(
  db: TenantDb,
  author: Author,
  id: string,
  patch: { name?: string; properties?: Record<string, unknown> },
): Promise<void> {
  if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot change objects");
  const { o, t } = await found(db, id);
  const next = { ...o.properties };
  for (const [k, v] of Object.entries(patch.properties ?? {})) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  const name = patch.name === undefined ? o.name : patch.name.trim();
  if (!name) throw new ManualEventError(400, "a name is required");
  await checkProperties(db, t, next, o.links);
  await guarded(() => db.query(`update objects set name = $3, properties = $4 where tenant_id = $1 and id = $2`, [db.tenantId, id, name, next]));
  const changed = Object.fromEntries(Object.keys(patch.properties ?? {}).map((k) => [k, { before: o.properties[k] ?? null, after: next[k] ?? null }]));
  await record(db, author, "object.update", {
    objectId: id, subject: name, data: { type: t.type, changed, ...(name !== o.name ? { rename: { before: o.name, after: name } } : {}) },
  });
}

/** Points a declared link at another object, or removes it (null) when it is not required. */
export async function setLink(db: TenantDb, author: Author, id: string, key: string, dst: string | null): Promise<void> {
  if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot change objects");
  const { o, t } = await found(db, id);
  const links = { ...o.links };
  if (dst) links[key] = dst;
  else delete links[key];
  if (!t.links[key]) throw new ManualEventError(400, `link "${key}" is not declared by ${t.type}`);
  await checkLinks(db, t, links);
  await checkProperties(db, t, o.properties, links);
  await guarded(() =>
    inTransaction(db.shared, async (c) => {
      const tdb = scoped(db, c);
      await tdb.query(`delete from links where tenant_id = $1 and src_id = $2 and type = $3`, [db.tenantId, id, key]);
      if (dst) await tdb.query(`insert into links (tenant_id, type, src_id, dst_id) values ($1, $2, $3, $4)`, [db.tenantId, key, id, dst]);
    }),
  );
  await record(db, author, "link.set", { objectId: id, subject: o.name, data: { link: key, before: o.links[key] ?? null, after: dst } });
}

/** Deletes an object nothing points at: no events, no objects linked to it. */
export async function deleteObject(db: TenantDb, author: Author, id: string): Promise<void> {
  if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot delete objects");
  const { o } = await found(db, id);
  const ev = await db.query(`select 1 from event_objects where tenant_id = $1 and object_id = $2 limit 1`, [db.tenantId, id]);
  if (ev.rowCount) throw new ManualEventError(409, "object has events");
  const inbound = await db.query(`select 1 from links where tenant_id = $1 and dst_id = $2 limit 1`, [db.tenantId, id]);
  if (inbound.rowCount) throw new ManualEventError(409, "other objects are linked to it");
  await db.query(`delete from objects where tenant_id = $1 and id = $2`, [db.tenantId, id]);
  await record(db, author, "object.delete", { objectId: id, subject: o.name, data: { type: o.type, properties: o.properties, links: o.links } });
}

export type { PropertySpec };
