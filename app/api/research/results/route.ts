/**
 * GET /api/research/results - a research pipeline reads back its project's results.
 * Auth: "Authorization: Bearer <source token>" with the read scope, of a source bound to a project. Query: the
 * filters of the project page (review, min, max, f.<key>, sort, order, q) plus offset and limit.
 */
import { ConnectorError } from "@/lib/engine/connectors";
import { authSource } from "@/lib/engine/source-auth";
import { pipelineResults } from "@/lib/research-pipeline";

export async function GET(request: Request) {
  const auth = await authSource(request, "read", (s) => s.connector === "push" ? null : "source does not accept push");
  if ("error" in auth) return auth.error;
  const { db, source } = auth;

  try {
    const page = await pipelineResults(db, source, new URL(request.url).searchParams);
    return Response.json(page, { headers: { "cache-control": "private, no-store" } });
  } catch (e) {
    if (e instanceof ConnectorError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
