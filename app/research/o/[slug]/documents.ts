import "server-only";
import { storeFromEnv } from "@/lib/engine/store";
import type { TenantDb } from "@/lib/engine/db";

export async function readDocument(db: TenantDb, id: string) {
  const { rows } = await db.query<{ storage_key: string; filename: string | null; content_type: string | null }>(
    `select storage_key, filename, content_type from documents where tenant_id = $1 and id = $2`,
    [db.tenantId, id],
  );
  const bytes = rows[0] && (await storeFromEnv().get(rows[0].storage_key));
  return bytes ? { bytes: new Uint8Array(bytes), filename: rows[0].filename, contentType: rows[0].content_type } : null;
}
