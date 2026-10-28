import { createHash } from "node:crypto";
import { forTenant, inTransaction, lockTenant, type Db, type TenantDb } from "./db";
import type { ModulePackage } from "./package";
import type { ObjectStore } from "./store";
import { sniffType } from "./mime";
import type { Source } from "./sources";
import { decodeText, extract, ExtractLimitError } from "./extract";
import { ConnectorError, uploadConnector, uploadConfig, type UploadConfig } from "./connectors";
import { dispatchIngestHooks, ingestPushInTransaction } from "./ingest";
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
  table: boolean;
  register: Register | null;
  rows: number;
  accepted: number;
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
  options: { replaceDocumentId?: string } = {},
): Promise<UploadResult> {
  if (source.connector !== "upload") throw new ConnectorError(403, "source does not accept uploads");
  if (source.status === "paused") throw new ConnectorError(403, "source is paused");
  const tdb = forTenant(db, source.tenant_id);
  const settings = await getSettings(db);
  const maxBytes = num(settings, "upload.max_bytes", 5 * 1024 ** 2);
  const maxRows = num(settings, "upload.max_rows", 5000);
  const perDay = num(settings, "upload.files_per_day", 50);
  const batch = Math.max(1, Math.floor(num(settings, "ingest.max_batch", 500)));

  if (!file.bytes.length) throw new ConnectorError(400, "file is empty");
  if (file.bytes.length > maxBytes) throw new ConnectorError(413, `file too large (max ${maxBytes} bytes)`);
  const overLimit = async (c: TenantDb) => !options.replaceDocumentId && (await documentsToday(c, source, now)) >= perDay;
  if (await overLimit(tdb)) throw new ConnectorError(429, `too many uploads (max ${perDay} per day)`);

  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const dup = await tdb.query(`select 1 from documents where tenant_id = $1 and source_id = $2 and sha256 = $3 and ($4::uuid is null or id <> $4)`, [
    source.tenant_id, source.id, sha256, options.replaceDocumentId ?? null,
  ]);
  if (dup.rowCount) throw new ConnectorError(409, "this file was already uploaded");

  let found: Awaited<ReturnType<typeof extract>>;
  try {
    found = await extract(file.name, file.type, file.bytes, { maxBytes, maxRows });
  } catch (e) {
    if (e instanceof ExtractLimitError) throw new ConnectorError(413, e.message);
    throw e;
  }
  const sheet = found.format === "csv" || found.format === "sheet";
  if (sheet && !found.table) throw new ConnectorError(400, "no table found in the file");
  const { mapping } = uploadConfig(source);
  const table = !!found.table && (sheet || found.table.headers.some((h) => mapping[h]));
  const messages = table ? await uploadConnector.messages(source, { table: found.table, maxRows }) : [];

  const key = `docs/${source.tenant_id}/${source.id}/${sha256}-${safeName(file.name)}`;
  const contentType = sniffType(file.bytes, found.format === "csv" ? "text/csv" : file.type);
  if (await store.putNew(key, file.bytes, contentType)) await db.query(`select engine_count('r2.writes', 1, $1)`, [now]);
  else if ((await tdb.query(
    `select 1 from documents where tenant_id = $1 and storage_key = $2 and ($3::uuid is null or id <> $3)`,
    [source.tenant_id, key, options.replaceDocumentId ?? null],
  )).rowCount) throw new ConnectorError(409, "this file was already uploaded");

  const { fixed } = uploadConfig(source);
  const register = table ? classify(messages, `${String(fixed?.kind ?? "")} ${file.name}`) : null;
  const objectIds = new Set<string>();
  const out: UploadResult = { documentId: "", table, register, rows: messages.length, accepted: 0, rejected: [], metrics: 0, events: 0 };
  const transitions = [] as Awaited<ReturnType<typeof ingestPushInTransaction>>["transitions"];
  try {
    const committed = await inTransaction(db, async (connection) => {
      const txdb = forTenant(connection, source.tenant_id);
      await lockTenant(connection, source.tenant_id, `documents:${source.id}`);
      if (await overLimit(txdb)) throw new ConnectorError(429, `too many uploads (max ${perDay} per day)`);
      if (options.replaceDocumentId) {
        const removed = await txdb.query(
          `delete from documents where tenant_id = $1 and id = $2 and source_id = $3 and metadata->>'kind' = 'upload' returning id`,
          [source.tenant_id, options.replaceDocumentId, source.id],
        );
        if (!removed.rowCount) throw new ConnectorError(404, "no such upload");
      }

      const { rows } = await txdb.query<{ id: string }>(
        `insert into documents (tenant_id, storage_key, filename, content_type, size, sha256, metadata, text_content, source_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [
          source.tenant_id, key, file.name, contentType, file.bytes.length, sha256, { kind: "upload", format: found.format, table, register },
          found.text?.replace(/\u0000/g, "").slice(0, 500_000) ?? null,
          source.id, now,
        ],
      );
      const documentId = (out.documentId = rows[0].id);

      if (register) {
        const units = found.table!.headers.filter((h) => ["dose", "quantity"].includes(mapping[h])).join(" ");
        const imported = await importAgronomy(connection, source, messages, register, actor, { units, now, documentId });
        out.accepted = imported.accepted;
        out.events = imported.events;
        out.rejected = imported.rejected.map((x) => ({ line: x.index + 2, error: x.error }));
        imported.objectIds.forEach((id) => objectIds.add(id));
      } else {
        for (let i = 0; i < messages.length; i += batch) {
          const loaded = await ingestPushInTransaction(connection, source, messages.slice(i, i + batch), pkg, now, { documentId });
          const result = loaded.result;
          out.accepted += result.accepted;
          out.metrics += result.metrics;
          out.events += result.events;
          out.rejected.push(...result.rejected.map((x) => ({ line: i + x.index + 2, error: x.error })));
          result.objectIds.forEach((id) => objectIds.add(id));
          transitions.push(...loaded.transitions);
        }
      }

      await txdb.query(`update documents set metadata = metadata || $3 where tenant_id = $1 and id = $2`, [
        source.tenant_id, documentId,
        { rows: out.rows, accepted: out.accepted, rejected: out.rejected.slice(0, 100), rejectedCount: out.rejected.length },
      ]);
      if (table && found.table && out.accepted) {
        const subjects = await knownSubjects(txdb);
        await txdb.query(`update sources set config = config || jsonb_build_object('memory', $3::jsonb) where tenant_id = $1 and id = $2`, [
          source.tenant_id, source.id, JSON.stringify(learn(readMemory(source.config.memory), found.table, mapping, subjects)),
        ]);
      }
      if (objectIds.size) await txdb.query(
        `insert into document_objects (tenant_id, document_id, object_id) select $1, $2, unnest($3::uuid[]) on conflict do nothing`,
        [source.tenant_id, documentId, [...objectIds]],
      );
      await record(txdb, actor, "upload.file", {
        subject: file.name,
        data: { source: source.name, rows: out.rows, accepted: out.accepted, rejected: out.rejected.length },
      });
      return out;
    });
    await dispatchIngestHooks(db, transitions);
    return committed;
  } catch (error) {
    if ((error as { constraint?: string }).constraint === "documents_source_sha") {
      throw new ConnectorError(409, "this file was already uploaded");
    }
    throw error;
  }
}

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

export async function knownSubjects(db: TenantDb, limit = 5000): Promise<Set<string>> {
  const { rows } = await db.query<{ n: string }>(
    `select distinct lower(name) n from objects where tenant_id = $1 and name is not null limit $2`,
    [db.tenantId, limit],
  );
  return new Set(rows.map((r) => r.n));
}

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

export async function countUploads(db: TenantDb, from?: Date): Promise<{ files: number; rejected: number }> {
  const { rows } = await db.query<{ files: number; rejected: number }>(
    `select count(*)::int files,
            coalesce(sum(case when metadata->>'rejectedCount' ~ '^[0-9]+$' then (metadata->>'rejectedCount')::int else 0 end), 0)::int rejected
       from documents
      where tenant_id = $1 and metadata->>'kind' = 'upload'
        and ($2::timestamptz is null or created_at >= $2)`,
    [db.tenantId, from ?? null],
  );
  return rows[0];
}

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
  return ingestUpload(
    db,
    store,
    source,
    { name: doc.filename ?? "file", type: doc.content_type ?? "", bytes },
    pkg,
    actor,
    new Date(),
    { replaceDocumentId: documentId },
  );
}

export { uploadConfig, decodeText };

export async function documentsToday(db: TenantDb, source: Source, now: Date) {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int n from documents where tenant_id = $1 and source_id = $2 and created_at > $3::timestamptz - interval '1 day'`,
    [source.tenant_id, source.id, now],
  );
  return rows[0].n;
}
