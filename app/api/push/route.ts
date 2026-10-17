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

const MAX_BODY = 4_000_000; // Vercel caps function bodies at 4.5 MB anyway

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

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error: "body too large" }, { status: 413 });
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return Response.json({ error: "body too large" }, { status: 413 });
    body = JSON.parse(text);
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
