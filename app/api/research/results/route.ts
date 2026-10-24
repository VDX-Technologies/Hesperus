/**
 * GET /api/research/results - a research pipeline reads back its project's results.
 * Auth: "Authorization: Bearer <source token>" of a source bound to a project. Query: the
 * filters of the project page (review, min, max, f.<key>, sort, order, q) plus offset and limit.
 */
import { crossTenantAccess, crossTenantDb } from "@/lib/engine/db";
import { ConnectorError } from "@/lib/engine/connectors";
import { takeIngestToken } from "@/lib/engine/ingest";
import { sourceByToken } from "@/lib/engine/sources";
import { pipelineResults } from "@/lib/research-pipeline";

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return Response.json({ error: "missing source token" }, { status: 401 });

  const db = crossTenantDb(crossTenantAccess.ingest);
  const source = await sourceByToken(db, token);
  if (!source) return Response.json({ error: "invalid source token" }, { status: 401 });
  if (source.connector !== "push") return Response.json({ error: "source does not accept push" }, { status: 403 });
  if (source.status === "paused") return Response.json({ error: "source is paused" }, { status: 403 });

  const wait = await takeIngestToken(db, source.id);
  if (wait > 0)
    return Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(wait)) } });

  try {
    const page = await pipelineResults(db, source, new URL(request.url).searchParams);
    return Response.json(page, { headers: { "cache-control": "private, no-store" } });
  } catch (e) {
    if (e instanceof ConnectorError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
