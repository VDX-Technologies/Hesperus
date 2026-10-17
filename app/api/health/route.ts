/**
 * GET /api/health - liveness for uptime monitors. 200 when the database answers and the last
 * hourly health run (scripts/health.ts) found no problem, 503 otherwise. Public, so it only
 * says how many problems there are; the details are in /admin/engine.
 */
import { getPool } from "@/lib/engine/db";

const STALE_MS = 2 * 3600_000; // the health job runs hourly

export async function GET() {
  try {
    const { rows } = await getPool().query<{ last_ok: Date | null; last_error: string | null; failing: number | null }>(
      `select last_ok, last_error,
              (select count(*) from jsonb_array_elements(last_result->'checks') c where c->>'ok' = 'false')::int failing
       from engine_jobs where name = 'health'`,
    );
    const h = rows[0];
    const fresh = !!h?.last_ok && Date.now() - h.last_ok.getTime() < STALE_MS;
    const body = {
      ok: fresh && !h.last_error && !h.failing,
      db: true,
      health_at: h?.last_ok?.toISOString() ?? null,
      health_stale: !fresh,
      problems: h?.failing ?? null,
    };
    return Response.json(body, { status: body.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false, db: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
