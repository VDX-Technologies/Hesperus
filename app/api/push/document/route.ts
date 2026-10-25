/**
 * POST /api/push/document - a file attached to an object of the tenant's own types.
 * Auth: "Authorization: Bearer <source token>" with the documents scope, of a push source of module "custom".
 * Body: multipart form with "file" and either "objectId" or "type" + "externalId".
 */
import { ConnectorError } from "@/lib/engine/connectors";
import { pushDocument } from "@/lib/engine/custom-ingest";
import { metered } from "@/lib/engine/health";
import { CUSTOM } from "@/lib/engine/registers";
import { authSource, readBody } from "@/lib/engine/source-auth";
import { storeFromEnv } from "@/lib/engine/store";

const MAX_BODY = 4_000_000;

export async function POST(request: Request) {
  const auth = await authSource(request, "documents", (s) =>
    s.connector === "push" && s.module === CUSTOM ? null : "source does not accept files");
  if ("error" in auth) return auth.error;
  const { db, source } = auth;

  // read within the limit first: formData() on the request itself would buffer a chunked body of any size
  const bytes = await readBody(request, MAX_BODY);
  if (bytes instanceof Response) return bytes;
  let form: FormData;
  try {
    form = await new Request(request.url, { method: "POST", body: bytes, headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await metered(db, storeFromEnv(), (store) => pushDocument(db, store, source, { name: file.name, type: file.type, bytes }, object));
    return Response.json(result, { status: result.status === "created" ? 201 : 200 });
  } catch (e) {
    if (e instanceof ConnectorError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
