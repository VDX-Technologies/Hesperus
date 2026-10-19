// Upload ingestion: the file is stored once on object storage with a documents row, then its
// rows go through the push path (raw archive, normalize, metrics, events, rules) in batches.
// The same bytes uploaded twice to one source are refused, so a retry never doubles events.
import { createHash } from "node:crypto";
import { forTenant, type Db, type TenantDb } from "./db";
import type { ModulePackage } from "./package";
import type { ObjectStore } from "./store";
import type { Source } from "./sources";
import { decodeText, extract } from "./extract";
import { ConnectorError, uploadConnector, uploadConfig, type UploadConfig } from "./connectors";
import { ingestPush, type IngestResult } from "./ingest";
import { getSettings, num } from "./settings";
import { record, type Actor } from "./audit";
import { learn, readMemory } from "../packages/records/recognize";
import { classify, importAgronomy, type Register } from "../packages/agronomy/import";

export interface UploadFile {
  name: string;
  type?: string;
  bytes: Uint8Array;
}

export interface UploadResult {
  documentId: string;
  /** False when the file is only kept as a document, with no rows read. */
  table: boolean;
  /** The register the rows went to when the file was recognised as agronomy work. */
  register: Register | null;
  rows: number;
  accepted: number;
  /** Rejected rows by line number in the file (the header is line 1). */
  rejected: { line: number; error: string }[];
  metrics: number;
  events: number;
}

const safeName = (name: string) => name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";

export async function ingestUpload(
  db: Db,
  store: ObjectStore,
  source: Source,
  file: UploadFile,
  pkg: ModulePackage,
  actor: Actor,
  now = new Date(),
): Promise<UploadResult> {
  if (source.connector !== "upload") throw new ConnectorError(403, "source does not accept uploads");
  if (source.status === "paused") throw new ConnectorError(403, "source is paused");
  const tdb = forTenant(db, source.tenant_id);
  const settings = await getSettings(db);
  const maxBytes = num(settings, "upload.max_bytes", 5 * 1024 ** 2);
  const maxRows = num(settings, "upload.max_rows", 5000);
  const perDay = num(settings, "upload.files_per_day", 50);
  const batch = num(settings, "ingest.max_batch", 500);

  if (!file.bytes.length) throw new ConnectorError(400, "file is empty");
  if (file.bytes.length > maxBytes) throw new ConnectorError(413, `file too large (max ${maxBytes} bytes)`);
  const { rows: day } = await tdb.query<{ n: number }>(
    `select count(*)::int n from documents where tenant_id = $1 and source_id = $2 and created_at > $3::timestamptz - interval '1 day'`,
    [source.tenant_id, source.id, now],
  );
  if (day[0].n >= perDay) throw new ConnectorError(429, `too many uploads (max ${perDay} per day)`);

  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const dup = await tdb.query(`select 1 from documents where tenant_id = $1 and source_id = $2 and sha256 = $3`, [
    source.tenant_id, source.id, sha256,
  ]);
  if (dup.rowCount) throw new ConnectorError(409, "this file was already uploaded");

  // Read before storing anything: a CSV or spreadsheet that cannot be read leaves no trace. Any
  // other file is kept even with no table in it; a table found in it is loaded when mapped.
  const found = await extract(file.name, file.type, file.bytes);
  const sheet = found.format === "csv" || found.format === "sheet";
  if (sheet && !found.table) throw new ConnectorError(400, "no table found in the file");
  const { mapping } = uploadConfig(source);
  const table = !!found.table && (sheet || found.table.headers.some((h) => mapping[h]));
  const messages = table ? await uploadConnector.messages(source, { table: found.table, maxRows }) : [];

  // Content-addressed key: putNew refuses an existing key, which also catches a concurrent retry.
  const key = `docs/${source.tenant_id}/${source.id}/${sha256}-${safeName(file.name)}`;
  const contentType = file.type || (found.format === "csv" ? "text/csv" : "application/octet-stream");
  // the archive never overwrites: a file deleted and loaded again finds its bytes already there
  if (await store.putNew(key, file.bytes, contentType)) await db.query(`select engine_count('r2.writes', 1, $1)`, [now]);
  else if ((await tdb.query(`select 1 from documents where tenant_id = $1 and storage_key = $2`, [source.tenant_id, key])).rowCount) throw new ConnectorError(409, "this file was already uploaded");

  // what the file is about decides the register: treatments go to the treatments register
  const { fixed } = uploadConfig(source);
  const register = table ? classify(messages, `${String(fixed?.kind ?? "")} ${file.name}`) : null;
  const out: UploadResult = { documentId: "", table, register, rows: messages.length, accepted: 0, rejected: [], metrics: 0, events: 0 };
  const objectIds = new Set<string>();
  // the document comes first so every event can say which file it came from
  const { rows } = await tdb.query<{ id: string }>(
    `insert into documents (tenant_id, storage_key, filename, content_type, size, sha256, metadata, text_content, source_id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      source.tenant_id, key, file.name, contentType, file.bytes.length, sha256, { kind: "upload", format: found.format, table, register },
      // the text is kept for search; postgres text cannot hold NUL
      found.text?.replace(/\u0000/g, "").slice(0, 500_000) ?? null,
      source.id, now,
    ],
  );
  const documentId = (out.documentId = rows[0].id);
  try {
    if (register) {
      // the unit a dose or quantity column is written in, from its header: "Dose (l/ha)"
      const units = found.table!.headers.filter((h) => ["dose", "quantity"].includes(mapping[h])).join(" ");
      const r = await importAgronomy(db, source, messages, register, actor, { units, now, documentId });
      out.accepted = r.accepted;
      out.events = r.events;
      out.rejected = r.rejected.map((x) => ({ line: x.index + 2, error: x.error }));
      r.objectIds.forEach((id) => objectIds.add(id));
    } else for (let i = 0; i < messages.length; i += batch) {
      const r: IngestResult = await ingestPush(db, source, messages.slice(i, i + batch), pkg, now, { documentId });
      out.accepted += r.accepted;
      out.metrics += r.metrics;
      out.events += r.events;
      out.rejected.push(...r.rejected.map((x) => ({ line: i + x.index + 2, error: x.error })));
      r.objectIds.forEach((id) => objectIds.add(id));
    }
  } catch (e) {
    // a load that broke halfway is taken back whole
    await tdb.query(`delete from documents where tenant_id = $1 and id = $2`, [source.tenant_id, documentId]);
    throw e;
  }
  await tdb.query(`update documents set metadata = metadata || $3 where tenant_id = $1 and id = $2`, [
    source.tenant_id, documentId,
    { rows: out.rows, accepted: out.accepted, rejected: out.rejected.slice(0, 100), rejectedCount: out.rejected.length },
  ]);
  // what this file taught: its signature and the traits of each mapped and ignored column
  if (table && found.table && out.accepted) {
    const subjects = await knownSubjects(tdb);
    await tdb.query(`update sources set config = config || jsonb_build_object('memory', $3::jsonb) where tenant_id = $1 and id = $2`, [
      source.tenant_id, source.id, JSON.stringify(learn(readMemory(source.config.memory), found.table, mapping, subjects)),
    ]);
  }
  if (objectIds.size) await tdb.query(
    `insert into document_objects (tenant_id, document_id, object_id) select $1, $2, unnest($3::uuid[]) on conflict do nothing`,
    [source.tenant_id, out.documentId, [...objectIds]],
  );
  await record(tdb, actor, "upload.file", {
    subject: file.name,
    data: { source: source.name, rows: out.rows, accepted: out.accepted, rejected: out.rejected.length },
  });
  return out;
}

/** Saves how a source reads its files; `fixed` is kept when not given. Only the source's tenant can change it. */
export async function saveUploadConfig(db: TenantDb, sourceId: string, cfg: UploadConfig, actor: Actor): Promise<void> {
  const mapping = Object.fromEntries(Object.entries(cfg.mapping).filter(([h, f]) => h.trim() && f.trim()));
  const { rows } = await db.query<{ name: string }>(
    `update sources set config = config || jsonb_strip_nulls(jsonb_build_object('mapping', $3::jsonb, 'fixed', $4::jsonb))
     where tenant_id = $1 and id = $2 and connector = 'upload' returning name`,
    [db.tenantId, sourceId, JSON.stringify(mapping), cfg.fixed ? JSON.stringify(cfg.fixed) : null],
  );
  if (!rows.length) throw new ConnectorError(404, "no such upload source");
  await record(db, actor, "upload.mapping", { subject: rows[0].name, data: { mapping } });
}

/** Names of the tenant's objects, lowercased, to recognise a column of subjects. */
export async function knownSubjects(db: TenantDb, limit = 5000): Promise<Set<string>> {
  const { rows } = await db.query<{ n: string }>(
    `select distinct lower(name) n from objects where tenant_id = $1 and name is not null limit $2`,
    [db.tenantId, limit],
  );
  return new Set(rows.map((r) => r.n));
}

/** Upload sources of a tenant with their mapping. */
export async function uploadSources(db: TenantDb): Promise<Source[]> {
  const { rows } = await db.query<Source>(
    `select id, tenant_id, name, connector, module, config, status from sources
     where tenant_id = $1 and connector = 'upload' order by name`,
    [db.tenantId],
  );
  return rows;
}

export interface UploadedDocument {
  id: string;
  filename: string | null;
  size: number;
  source: string | null;
  createdAt: Date;
  table: boolean;
  rows: number;
  accepted: number;
  rejected: { line: number; error: string }[];
  rejectedCount: number;
  register: string | null;
  events: number;
}

/** Latest uploaded files, newest first. */
export async function listUploads(db: TenantDb, limit = 20): Promise<UploadedDocument[]> {
  const { rows } = await db.query<{
    id: string; filename: string | null; size: string; source: string | null; created_at: Date; metadata: Record<string, unknown>; events: number;
  }>(
    `select d.id, d.filename, d.size, s.name source, d.created_at, d.metadata,
            (select count(*)::int from events e where e.tenant_id = d.tenant_id and e.document_id = d.id) events
     from documents d left join sources s on s.id = d.source_id and s.tenant_id = d.tenant_id
     where d.tenant_id = $1 and d.metadata->>'kind' = 'upload'
     order by d.created_at desc limit $2`,
    [db.tenantId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    size: Number(r.size),
    source: r.source,
    createdAt: r.created_at,
    table: r.metadata.table !== false,
    rows: Number(r.metadata.rows ?? 0),
    accepted: Number(r.metadata.accepted ?? 0),
    rejected: (r.metadata.rejected as UploadedDocument["rejected"]) ?? [],
    rejectedCount: Number(r.metadata.rejectedCount ?? 0),
    register: typeof r.metadata.register === "string" ? r.metadata.register : null,
    events: r.events,
  }));
}

/** Deletes an uploaded file and everything read from it (its events go by cascade). */
export async function deleteUpload(db: TenantDb, documentId: string, actor: Actor): Promise<{ filename: string | null; events: number } | null> {
  const { rows } = await db.query<{ filename: string | null; events: number }>(
    `select filename, (select count(*)::int from events e where e.tenant_id = d.tenant_id and e.document_id = d.id) events
     from documents d where tenant_id = $1 and id = $2 and metadata->>'kind' = 'upload'`,
    [db.tenantId, documentId],
  );
  if (!rows.length) return null;
  await db.query(`delete from documents where tenant_id = $1 and id = $2`, [db.tenantId, documentId]);
  await record(db, actor, "upload.delete", { subject: rows[0].filename, data: { events: rows[0].events } });
  return rows[0];
}

/**
 * Reads an uploaded file again from the archive with the source's current mapping: what it loaded
 * before is removed, then the file is classified and loaded as if new.
 */
export async function reprocessUpload(
  db: Db,
  store: ObjectStore,
  tenantId: string,
  documentId: string,
  pkgOf: (module: string) => ModulePackage | undefined,
  actor: Actor,
): Promise<UploadResult> {
  const tdb = forTenant(db, tenantId);
  const { rows } = await tdb.query<{ storage_key: string; filename: string | null; content_type: string | null; source_id: string | null }>(
    `select storage_key, filename, content_type, source_id from documents where tenant_id = $1 and id = $2 and metadata->>'kind' = 'upload'`,
    [tenantId, documentId],
  );
  const doc = rows[0];
  const source = doc && (await uploadSources(tdb)).find((s) => s.id === doc.source_id);
  const pkg = source && pkgOf(source.module);
  if (!doc || !source || !pkg) throw new ConnectorError(404, "no such upload");
  const bytes = await store.get(doc.storage_key);
  if (!bytes) throw new ConnectorError(404, "file missing from the archive");
  await tdb.query(`delete from documents where tenant_id = $1 and id = $2`, [tenantId, documentId]);
  return ingestUpload(db, store, source, { name: doc.filename ?? "file", type: doc.content_type ?? "", bytes }, pkg, actor);
}

export { uploadConfig, decodeText };
