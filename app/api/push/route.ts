/**
 * POST /api/push - generic push ingestion.
 * Auth: "Authorization: Bearer <source token>". Body: one message or an array of messages,
 * interpreted by the source's module package.
 */
import { getPool } from "@/lib/engine/db";
import { ConnectorError, pushConnector } from "@/lib/engine/connectors";
import { ingestPush } from "@/lib/engine/ingest";
import { ValidationError } from "@/lib/engine/package";
import { sourceByToken } from "@/lib/engine/sources";
import { getPackage } from "@/lib/packages";

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return Response.json({ error: "missing source token" }, { status: 401 });

  const db = getPool();
  const source = await sourceByToken(db, token);
  if (!source) return Response.json({ error: "invalid source token" }, { status: 401 });
  if (source.connector !== "push") return Response.json({ error: "source does not accept push" }, { status: 403 });
  if (source.status === "paused") return Response.json({ error: "source is paused" }, { status: 403 });
  const pkg = getPackage(source.module);
  if (!pkg) return Response.json({ error: `module "${source.module}" is not installed` }, { status: 500 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const result = await ingestPush(db, source, await pushConnector.messages(source, body), pkg);
    return Response.json(result, { status: result.rejected.length && !result.accepted ? 422 : 200 });
  } catch (e) {
    if (e instanceof ConnectorError) return Response.json({ error: e.message }, { status: e.status });
    if (e instanceof ValidationError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
