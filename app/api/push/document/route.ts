/**
 * POST /api/push/document - a file attached to an object of the tenant's own types.
 * Auth: "Authorization: Bearer <source token>" of a push source of module "custom".
 * Body: multipart form with "file" and either "objectId" or "type" + "externalId".
 */
import { crossTenantAccess, crossTenantDb } from "@/lib/engine/db";
import { ConnectorError } from "@/lib/engine/connectors";
import { pushDocument } from "@/lib/engine/custom-ingest";
import { takeIngestToken } from "@/lib/engine/ingest";
import { CUSTOM } from "@/lib/engine/registers";
import { sourceByToken } from "@/lib/engine/sources";
import { storeFromEnv } from "@/lib/engine/store";

const MAX_BODY = 4_000_000;

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return Response.json({ error: "missing source token" }, { status: 401 });

  const db = crossTenantDb(crossTenantAccess.ingest);
  const source = await sourceByToken(db, token);
  if (!source) return Response.json({ error: "invalid source token" }, { status: 401 });
  if (source.connector !== "push" || source.module !== CUSTOM) return Response.json({ error: "source does not accept files" }, { status: 403 });
  if (source.status === "paused") return Response.json({ error: "source is paused" }, { status: 403 });

  const wait = await takeIngestToken(db, source.id);
  if (wait > 0)
    return Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(wait)) } });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error: "body too large" }, { status: 413 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "expected a multipart form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: `missing "file"` }, { status: 400 });
  const objectId = form.get("objectId"), type = form.get("type"), externalId = form.get("externalId");
  const object = typeof objectId === "string" && objectId ? objectId
    : typeof type === "string" && typeof externalId === "string" ? { type, externalId } : null;
  if (!object) return Response.json({ error: `missing "objectId" or "type" and "externalId"` }, { status: 400 });

  try {
    const result = await pushDocument(db, storeFromEnv(), source, { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }, object);
    return Response.json(result, { status: result.status === "created" ? 201 : 200 });
  } catch (e) {
    if (e instanceof ConnectorError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
