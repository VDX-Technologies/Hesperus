// Public platform status (/status): the last hourly health run reduced to a few components.
// Only check keys are read, never their messages (those name customers and sources), and
// per-customer checks (silent sources, rate limits) are not platform problems so they are left out.
import type { Db } from "./db";

export type Level = "ok" | "degraded" | "down" | "unknown";
export type Component = "database" | "ingest" | "storage" | "monitoring";

export interface PlatformStatus {
  overall: Level;
  components: Record<Component, Level>;
  /** The last health run (ISO), null when it never ran or the database did not answer. */
  checkedAt: string | null;
}

export const STALE_MS = 2 * 3600_000; // the health job runs hourly

export interface HealthRow {
  last_ok: string | null;
  last_error: string | null;
  checks: { key: string; ok: boolean }[];
}

const worst = (levels: Level[]): Level =>
  (["down", "degraded", "unknown", "ok"] as const).find((l) => levels.includes(l)) ?? "ok";

/** row: the health job, undefined when it never ran, null when the database did not answer. */
export function platformStatus(row: HealthRow | null | undefined, now = new Date()): PlatformStatus {
  if (row === null)
    return { overall: "down", checkedAt: null, components: { database: "down", ingest: "unknown", storage: "unknown", monitoring: "unknown" } };
  const fresh = !!row?.last_ok && now.getTime() - Date.parse(row.last_ok) < STALE_MS;
  const failing = (prefix: string) => (row?.checks ?? []).some((c) => c.key.startsWith(prefix) && !c.ok);
  // without a recent run the other components are not known
  const known = (bad: boolean): Level => (!fresh ? "unknown" : bad ? "degraded" : "ok");
  const components: Record<Component, Level> = {
    database: "ok",
    ingest: known(failing("raw.") || failing("job.")),
    storage: known(failing("quota.")),
    monitoring: fresh && !row?.last_error ? "ok" : "degraded",
  };
  return { overall: worst(Object.values(components)), components, checkedAt: row?.last_ok ?? null };
}

export async function readStatus(db: Db, now = new Date()): Promise<PlatformStatus> {
  let row: HealthRow | undefined;
  try {
    const { rows } = await db.query<{ last_ok: Date | null; last_error: string | null; checks: { key: string; ok: boolean }[] | null }>(
      `select last_ok, last_error,
              (select jsonb_agg(jsonb_build_object('key', c->>'key', 'ok', (c->>'ok')::boolean))
               from jsonb_array_elements(last_result->'checks') c) checks
       from engine_jobs where name = 'health'`,
    );
    const r = rows[0];
    row = r && { last_ok: r.last_ok?.toISOString() ?? null, last_error: r.last_error, checks: r.checks ?? [] };
  } catch {
    return platformStatus(null, now);
  }
  return platformStatus(row, now);
}
