// Registers: every event type with a schema gets a list, an entry form and its exports, with no
// code of its own. Types come from the enabled packages and from the tenant's schema editor
// (module "custom", stored in event_types and validated by the same trigger). This file only
// knows schemas, objects and events: what a field means is up to the type.
import type { TenantDb } from "./db";
import type { EventQuery, EventRow } from "./events";
import type { EventSpec, Author } from "./manual";
import { ManualEventError } from "./manual";
import type { ModulePackage, PropertySpec } from "./package";
import { record } from "./audit";
import { getSettings, num } from "./settings";
import { checkFields, KEY, parseDecimal, type Quantity, type Schema } from "./schema";

export type Locale = "en" | "it";

export interface EventTypeInfo {
  /** "agronomy.treatment", "custom.pruning" */
  type: string;
  module: string;
  key: string;
  name: Record<string, string>;
  fields: Schema;
  subject: string | null;
  fromSubject: Record<string, string>;
  /** Other object types the event may be linked to after its subject. */
  also: string[];
  /** Made in the schema editor (editable by the owner). */
  custom: boolean;
}

export const CUSTOM = "custom";
export const FIELD_TYPES = ["string", "number", "integer", "boolean", "timestamp", "quantity", "object"] as const;

export const label = (text: Record<string, string> | undefined, locale: Locale, fallback: string) => text?.[locale] ?? text?.en ?? fallback;

/** The fields in the editor's order; keys missing from the order (none, normally) go last. */
const ordered = (fields: Schema, order: string[] | null): Schema =>
  Object.fromEntries([...(order ?? []).filter((k) => k in fields), ...Object.keys(fields).filter((k) => !order?.includes(k))].map((k) => [k, fields[k]]));

/** Package types first (in package order), then the tenant's own, by name. */
export async function listEventTypes(db: TenantDb, pkgs: ModulePackage[]): Promise<EventTypeInfo[]> {
  const fromPkgs = pkgs.flatMap((p) =>
    (p.eventTypes ?? []).map((t) => ({
      type: `${p.id}.${t.key}`, module: p.id, key: t.key, name: t.name, fields: t.fields, subject: t.subject ?? null, fromSubject: t.fromSubject ?? {}, also: t.also ?? [], custom: false,
    })),
  );
  const { rows } = await db.query<{ key: string; name: Record<string, string>; fields: Schema; subject: string | null; from_subject: Record<string, string>; field_order: string[] | null; also: string[] }>(
    `select key, name, fields, subject, from_subject, field_order, also from event_types where tenant_id = $1 and module = $2 order by name->>'en', key`,
    [db.tenantId, CUSTOM],
  );
  const own = rows.map((r) => ({
    type: `${CUSTOM}.${r.key}`, module: CUSTOM, key: r.key, name: r.name, fields: ordered(r.fields, r.field_order), subject: r.subject, fromSubject: r.from_subject ?? {}, also: r.also ?? [], custom: true,
  }));
  return [...fromPkgs, ...own];
}

export async function getEventType(db: TenantDb, pkgs: ModulePackage[], type: string): Promise<EventTypeInfo | null> {
  return (await listEventTypes(db, pkgs)).find((t) => t.type === type) ?? null;
}

export const specOf = (t: EventTypeInfo, pkgs: ModulePackage[]): EventSpec => ({
  type: t.type, module: t.module, fields: t.fields, subject: t.subject, also: t.also, pkg: pkgs.find((p) => p.id === t.module),
});

/** Object types the tenant has objects of, and its own ones: what a custom type can be about. */
export async function subjectTypes(db: TenantDb): Promise<{ type: string; name: Record<string, string> }[]> {
  const { rows } = await db.query<{ type: string; name: Record<string, string> }>(
    `select distinct t.module || '.' || t.key type, t.name from object_types t
      where t.tenant_id = $1 or exists (select 1 from objects o where o.tenant_id = $1 and o.type_id = t.id) order by 1`,
    [db.tenantId],
  );
  return rows;
}

export interface SubjectObject {
  id: string;
  name: string;
  properties: Record<string, unknown>;
  archived: boolean;
}

/** Objects of a type, by name; archived ones only with `all` (they stay readable, not choosable). */
export async function subjectObjects(db: TenantDb, subject: string | null, opts: { all?: boolean } = {}): Promise<SubjectObject[]> {
  const { rows } = await db.query<{ id: string; name: string | null; external_id: string | null; properties: Record<string, unknown> }>(
    `select o.id, o.name, o.external_id, o.properties from objects o join object_types t on t.id = o.type_id
      where o.tenant_id = $1 and ($2::text is null or t.module || '.' || t.key = $2)
        and ($3 or coalesce(o.properties->>'status', '') <> 'archived')
      order by coalesce(o.name, o.external_id), o.id`,
    [db.tenantId, subject, opts.all ?? false],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name ?? r.external_id ?? r.id.slice(0, 8), properties: r.properties ?? {}, archived: r.properties?.status === "archived",
  }));
}

/** Values already written in the type's free-text fields, most used first, for autocomplete. */
export async function fieldSuggestions(db: TenantDb, t: EventTypeInfo): Promise<Record<string, string[]>> {
  const fields = Object.entries(t.fields).filter(([, s]) => s.type === "string" && !s.enum).map(([k]) => k);
  if (!fields.length) return {};
  const { rows } = await db.query<{ field: string; v: string }>(
    `select f.field, e.payload->>f.field v
       from events_current e cross join unnest($3::text[]) f(field)
      where e.tenant_id = $1 and e.type = $2 and coalesce(e.payload->>f.field, '') <> ''
      group by 1, 2 order by count(*) desc, 2 limit 1000`,
    [db.tenantId, t.type, fields],
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.field] ??= []).push(r.v);
  return out;
}

// ---- filters --------------------------------------------------------------------------------

export interface RegisterFilters {
  /** yyyy-mm-dd, both days included */
  from?: string;
  to?: string;
  obj?: string;
  /** Field values, exact match. */
  fields: Record<string, string>;
}

export const filterable = (s: PropertySpec) => s.type === "string" || s.type === "boolean" || s.type === "integer" || s.type === "number";

/** Filters from the query string: from, to, obj and f.<field>. */
export function filtersFrom(t: EventTypeInfo, sp: Record<string, string | string[] | undefined>): RegisterFilters {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const fields: Record<string, string> = {};
  for (const [k, s] of Object.entries(t.fields)) {
    const v = one(`f.${k}`);
    if (v && filterable(s)) fields[k] = v;
  }
  return { from: one("from"), to: one("to"), obj: one("obj"), fields };
}

export function filterParams(f: RegisterFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.obj) p.set("obj", f.obj);
  for (const [k, v] of Object.entries(f.fields)) p.set(`f.${k}`, v);
  return p;
}

const day = (s: string | undefined, plus = 0) => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : new Date(d.getTime() + plus * 86400000);
};

/** The filters as an event query, all applied by the database. */
export function registerQuery(t: EventTypeInfo, f: RegisterFilters): EventQuery {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f.fields)) {
    const s = t.fields[k];
    if (!s) continue;
    if (s.type === "boolean") payload[k] = v === "true";
    else if (s.type === "number" || s.type === "integer") {
      const n = parseDecimal(v);
      if (n !== null) payload[k] = n;
    } else payload[k] = v;
  }
  return {
    types: [t.type],
    objectId: f.obj && /^[0-9a-f-]{36}$/i.test(f.obj) ? f.obj : undefined,
    recursive: false,
    from: day(f.from),
    to: day(f.to, 1),
    payload: Object.keys(payload).length ? payload : undefined,
  };
}

// ---- cells and CSV ---------------------------------------------------------------------------

const number = (v: number, locale: Locale) => v.toLocaleString(locale === "it" ? "it-IT" : "en-GB", { maximumFractionDigits: 3 });
const date = (iso: string, locale: Locale) => (locale === "it" ? iso.split("-").reverse().join("/") : iso);

/** A payload value as text for a list or a PDF. */
export function fieldText(spec: PropertySpec | undefined, v: unknown, locale: Locale): string {
  if (v === undefined || v === null || v === "") return "";
  if (!spec) return typeof v === "object" ? JSON.stringify(v) : String(v);
  if (spec.type === "quantity") {
    const q = v as Quantity;
    return typeof q?.value === "number" ? `${number(q.value, locale)} ${q.unit}` : "";
  }
  if (spec.type === "number" || spec.type === "integer") return typeof v === "number" ? number(v, locale) : String(v);
  if (spec.type === "boolean") return v ? (locale === "it" ? "sì" : "yes") : "no";
  if (spec.type === "timestamp") return date(String(v).slice(0, 10), locale);
  if (spec.enum && typeof v === "string") return spec.options?.[v]?.[locale] ?? v;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export interface RegisterColumn {
  key: string;
  label: string;
}

/** Date, object, one column per field, who recorded it. */
export function registerColumns(t: EventTypeInfo, locale: Locale, text: { date: string; object: string; author: string }): RegisterColumn[] {
  return [
    { key: "_date", label: text.date },
    { key: "_object", label: text.object },
    ...Object.entries(t.fields).map(([k, s]) => ({ key: k, label: label(s.label, locale, k) })),
    { key: "_author", label: text.author },
  ];
}

export function registerCell(t: EventTypeInfo, e: EventRow, key: string, objects: Map<string, string>, locale: Locale): string {
  if (key === "_date") return date(e.ts.toISOString().slice(0, 10), locale);
  if (key === "_object") return e.objectIds.map((id) => objects.get(id) ?? id.slice(0, 8)).join(", ");
  if (key === "_author") return e.authorLabel ?? "";
  return fieldText(t.fields[key], e.payload[key], locale);
}

export const csvCell = (value: string) => {
  // Text cells that begin with spreadsheet formula characters must stay inert when opened in Excel.
  // Keep plain numeric values (including negative numbers) numeric.
  const numeric = /^-?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][-+]?\d+)?$/.test(value.trim());
  const formula = /^[\u0000-\u0020]*[=+\-@]/.test(value);
  const v = formula && !numeric ? `'${value}` : value;
  return /[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
export const dec = (v: unknown) => (typeof v === "number" ? String(v).replace(".", ",") : "");

/** Header of the CSV (keys, not labels: stable for whoever reads it); a quantity takes two columns. */
export function csvHeader(t: EventTypeInfo): string {
  const fields = Object.entries(t.fields).flatMap(([k, s]) => (s.type === "quantity" ? [k, `${k}_unit`] : [k]));
  return "﻿" + ["date", "object", ...fields, "recorded_by", "recorded_at", "version", "id"].join(";") + "\r\n";
}

/** One CSV line: semicolons, comma decimals, so it opens as is in a spreadsheet set to Italian. */
export function csvLine(t: EventTypeInfo, e: EventRow, objects: Map<string, string>): string {
  const cells = Object.entries(t.fields).flatMap(([k, s]) => {
    const v = e.payload[k];
    if (s.type === "quantity") {
      const q = v as Quantity | undefined;
      return [dec(q?.value), q?.unit ?? ""];
    }
    if (s.type === "number" || s.type === "integer") return [dec(v)];
    if (s.type === "boolean") return [v === undefined ? "" : v ? "true" : "false"];
    return [v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)];
  });
  return [
    e.ts.toISOString().slice(0, 10), e.objectIds.map((id) => objects.get(id) ?? id).join(", "), ...cells,
    e.authorLabel ?? "", e.recordedAt.toISOString(), String(e.version), String(e.rootId),
  ].map(csvCell).join(";") + "\r\n";
}

// ---- schema editor ---------------------------------------------------------------------------

export interface EventTypeInput {
  key: string;
  name: Record<string, string>;
  fields: Schema;
  subject: string;
  fromSubject?: Record<string, string>;
  also?: string[];
}

const TYPE = /^[a-z][a-z0-9_]{0,39}\.[a-z][a-z0-9_]{0,39}$/;

/** Problems of a type definition, null when fine. */
export function checkEventType(input: EventTypeInput): string | null {
  if (!KEY.test(input.key)) return "invalid key";
  if (!Object.values(input.name).some((n) => n?.trim())) return "a name is required";
  if (!input.subject?.trim()) return "a subject type is required";
  if (!Object.keys(input.fields).length) return "at least one field is required";
  const err = checkFields(input.fields, FIELD_TYPES);
  if (err) return err;
  if (Object.values(input.fields).some((s) => s.format === "schema" || s.schemaFrom)) return "schemas belong to object types";
  for (const [k, s] of Object.entries(input.fields)) {
    if (s.format === "text" && s.type !== "string") return `"${k}": only string fields are written on several lines`;
    if (s.format && s.format !== "text") return `"${k}": unknown format`;
  }
  for (const k of Object.keys(input.fromSubject ?? {})) if (!input.fields[k]) return `unknown field "${k}"`;
  for (const t of input.also ?? []) if (!TYPE.test(t) || t === input.subject) return `invalid linked type "${t}"`;
  if ((input.also?.length ?? 0) > 5) return "too many linked types";
  return null;
}

/** Creates or replaces a type of the tenant. Only the owner; events already recorded stay as they are. */
export async function saveEventType(db: TenantDb, author: Author, input: EventTypeInput): Promise<string> {
  if (author.role !== "owner") throw new ManualEventError(403, "only the owner manages event types");
  const err = checkEventType(input);
  if (err) throw new ManualEventError(400, err);
  const { rows: existing } = await db.query(`select 1 from event_types where tenant_id = $1 and module = $2 and key = $3`, [db.tenantId, CUSTOM, input.key]);
  if (!existing.length) {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int n from event_types where tenant_id = $1`, [db.tenantId]);
    if (rows[0].n >= num(await getSettings(db.shared), "registers.types_max", 50)) throw new ManualEventError(429, "event type limit reached");
  }
  await db.query(
    `insert into event_types (tenant_id, module, key, name, fields, subject, from_subject, field_order, also) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (tenant_id, module, key) where tenant_id is not null
     do update set name = excluded.name, fields = excluded.fields, subject = excluded.subject, from_subject = excluded.from_subject,
                   field_order = excluded.field_order, also = excluded.also`,
    [db.tenantId, CUSTOM, input.key, input.name, input.fields, input.subject, input.fromSubject ?? {}, Object.keys(input.fields), [...new Set(input.also ?? [])]],
  );
  const type = `${CUSTOM}.${input.key}`;
  await record(db, author, existing.length ? "event_type.update" : "event_type.create", { subject: type, data: { ...input } });
  return type;
}

// ---- form values ------------------------------------------------------------------------------

/** The entry form: the day of the event (`_ts`) then the type's fields. */
export const formSchema = (t: EventTypeInfo): Schema => ({ _ts: { type: "timestamp", required: true, label: { en: "Date", it: "Data" } }, ...t.fields });

/** A value as form text: comma decimals, dates as yyyy-mm-dd. */
export function formText(spec: PropertySpec | undefined, v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  const dec = (n: unknown) => (typeof n === "number" ? String(n).replace(".", ",") : "");
  if (spec?.type === "quantity") {
    const q = v as Partial<Quantity>;
    return { "": dec(q.value), ".unit": q.unit ?? "" };
  }
  if (typeof v === "number") return { "": dec(v) };
  if (spec?.type === "timestamp") return { "": String(v).slice(0, 10) };
  return { "": typeof v === "object" ? JSON.stringify(v) : String(v) };
}

/** A recorded event back into form text, for "Repeat last" and corrections. */
export function eventValues(t: EventTypeInfo, e: { ts: Date; payload: Record<string, unknown>; objectIds: string[] }): Record<string, string> {
  const out: Record<string, string> = { _object: e.objectIds[0] ?? "", _also: e.objectIds.slice(1).join(","), _ts: e.ts.toISOString().slice(0, 10) };
  for (const [k, s] of Object.entries(t.fields)) for (const [suffix, v] of Object.entries(formText(s, e.payload[k]))) out[k + suffix] = v;
  return out;
}

/** Form text the type takes from an object when it is chosen (fromSubject: field ← property). */
export function subjectValues(t: EventTypeInfo, o: SubjectObject): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, prop] of Object.entries(t.fromSubject))
    for (const [suffix, v] of Object.entries(formText(t.fields[field], o.properties[prop]))) out[field + suffix] = v;
  return out;
}

/** An object's properties back into form text, for editing it with its schema's form. */
export function propertyValues(schema: Schema, properties: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, s] of Object.entries(schema)) for (const [suffix, v] of Object.entries(formText(s, properties[k]))) out[k + suffix] = v;
  return out;
}
