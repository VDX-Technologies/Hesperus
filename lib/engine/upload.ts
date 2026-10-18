// Upload ingestion: the file is stored once on object storage with a documents row, then its
// rows go through the push path (raw archive, normalize, metrics, events, rules) in batches.
// The same bytes uploaded twice to one source are refused, so a retry never doubles events.
import { createHash } from "node:crypto";
import { forTenant, type Db, type TenantDb } from "./db";
import type { ModulePackage } from "./package";
import type { ObjectStore } from "./store";
import type { Source } from "./sources";
import { ConnectorError, uploadConnector, uploadConfig, type UploadConfig } from "./connectors";
import { ingestPush, type IngestResult } from "./ingest";
import { getSettings, num } from "./settings";
import { record, type Actor } from "./audit";

export interface UploadFile {
  name: string;
  type?: string;
  bytes: Uint8Array;
}

export interface UploadResult {
  documentId: string;
  rows: number;
  accepted: number;
  /** Rejected rows by line number in the file (the header is line 1). */
  rejected: { line: number; error: string }[];
  metrics: number;
  events: number;
}

/** UTF-8 if valid, else Windows-1252 (what spreadsheets on Windows export). */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
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

  // Parse before storing anything: a file that cannot be read leaves no trace.
  const messages = await uploadConnector.messages(source, { text: decodeText(file.bytes), maxRows });

  // Content-addressed key: putNew refuses an existing key, which also catches a concurrent retry.
  const key = `docs/${source.tenant_id}/${source.id}/${sha256}-${safeName(file.name)}`;
  const contentType = file.type || "text/csv";
  if (!(await store.putNew(key, file.bytes, contentType))) throw new ConnectorError(409, "this file was already uploaded");
  await db.query(`select engine_count('r2.writes', 1, $1)`, [now]);

  const out: UploadResult = { documentId: "", rows: messages.length, accepted: 0, rejected: [], metrics: 0, events: 0 };
  const objectIds = new Set<string>();
  for (let i = 0; i < messages.length; i += batch) {
    const r: IngestResult = await ingestPush(db, source, messages.slice(i, i + batch), pkg, now);
    out.accepted += r.accepted;
    out.metrics += r.metrics;
    out.events += r.events;
    out.rejected.push(...r.rejected.map((x) => ({ line: i + x.index + 2, error: x.error })));
    r.objectIds.forEach((id) => objectIds.add(id));
  }

  const { rows } = await tdb.query<{ id: string }>(
    `insert into documents (tenant_id, storage_key, filename, content_type, size, sha256, metadata, source_id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      source.tenant_id, key, file.name, contentType, file.bytes.length, sha256,
      { kind: "upload", rows: out.rows, accepted: out.accepted, rejected: out.rejected.slice(0, 100), rejectedCount: out.rejected.length },
      source.id, now,
    ],
  );
  out.documentId = rows[0].id;
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
  rows: number;
  accepted: number;
  rejected: { line: number; error: string }[];
  rejectedCount: number;
}

/** Latest uploaded files, newest first. */
export async function listUploads(db: TenantDb, limit = 20): Promise<UploadedDocument[]> {
  const { rows } = await db.query<{
    id: string; filename: string | null; size: string; source: string | null; created_at: Date; metadata: Record<string, unknown>;
  }>(
    `select d.id, d.filename, d.size, s.name source, d.created_at, d.metadata
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
    rows: Number(r.metadata.rows ?? 0),
    accepted: Number(r.metadata.accepted ?? 0),
    rejected: (r.metadata.rejected as UploadedDocument["rejected"]) ?? [],
    rejectedCount: Number(r.metadata.rejectedCount ?? 0),
  }));
}

export { uploadConfig };
