// engine_settings, the single place for limits, windows and frequencies (jobs in SQL read
// the same table). Cached briefly per process.
import type { Db } from "./db";

export type Settings = Record<string, unknown>;

const TTL_MS = 60_000;
let cache: { at: number; values: Settings } | undefined;

export async function getSettings(db: Db, fresh = false): Promise<Settings> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const { rows } = await db.query<{ key: string; value: unknown }>("select key, value from engine_settings");
  cache = { at: Date.now(), values: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return cache.values;
}

export function num(s: Settings, key: string, fallback: number): number {
  const v = s[key];
  return typeof v === "number" ? v : fallback;
}
