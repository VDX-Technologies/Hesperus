/**
 * GET /api/health - liveness for uptime monitors. 200 when the database answers and the last
 * hourly health run (scripts/health.ts) found no problem, 503 otherwise. Public, so it only
 * says ok; with `Authorization: Bearer $HEALTH_TOKEN` it adds the age of the run and the number
 * of problems (the details are in /admin/engine).
 */
import { timingSafeEqual } from "node:crypto";
import { crossTenantAccess, crossTenantDb } from "@/lib/engine/db";

const STALE_MS = 2 * 3600_000; // the health job runs hourly
const headers = { "cache-control": "no-store" };

function authorized(request: Request) {
  const token = process.env.HEALTH_TOKEN;
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token || !given) return false;
  const [a, b] = [Buffer.from(given), Buffer.from(token)];
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const detailed = authorized(request);
  try {
    const { rows } = await crossTenantDb(crossTenantAccess.maintenance).query<{ last_ok: Date | null; last_error: string | null; failing: number | null }>(
      `select last_ok, last_error,
              (select count(*) from jsonb_array_elements(last_result->'checks') c where c->>'ok' = 'false')::int failing
       from engine_jobs where name = 'health'`,
    );
    const h = rows[0];
    const fresh = !!h?.last_ok && Date.now() - h.last_ok.getTime() < STALE_MS;
    const ok = fresh && !h.last_error && !h.failing;
    const body = detailed
      ? { ok, db: true, health_at: h?.last_ok?.toISOString() ?? null, health_stale: !fresh, problems: h?.failing ?? null }
      : { ok };
    return Response.json(body, { status: ok ? 200 : 503, headers });
  } catch {
    return Response.json(detailed ? { ok: false, db: false } : { ok: false }, { status: 503, headers });
  }
}
