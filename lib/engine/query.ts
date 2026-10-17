// Time series reads. The span picks the level: up to query.raw_max_hours from raw metrics,
// up to query.rollup_5m_max_days from 5 min rollups, longer from hourly rollups.
import type { Db } from "./db";
import { getSettings, num } from "./settings";

export type Level = "raw" | "5m" | "1h";

export interface Point {
  ts: Date;
  value: number;
  min?: number;
  max?: number;
}

export async function pickLevel(db: Db, from: Date, to: Date): Promise<Level> {
  const s = await getSettings(db);
  const hours = (to.getTime() - from.getTime()) / 3_600_000;
  if (hours <= num(s, "query.raw_max_hours", 24)) return "raw";
  if (hours <= num(s, "query.rollup_5m_max_days", 7) * 24) return "5m";
  return "1h";
}

/** Series per metric key for one object, at the level the span calls for (or a forced one). */
export async function series(
  db: Db,
  q: { objectId: string; module: string; metrics: string[]; from: Date; to: Date; level?: Level },
): Promise<{ level: Level; series: Record<string, Point[]> }> {
  const level = q.level ?? (await pickLevel(db, q.from, q.to));
  const sql =
    level === "raw"
      ? `select k.key, m.ts, m.value from metrics m join metric_keys k on k.id = m.metric_id
         where m.object_id = $1 and k.module = $2 and k.key = any($3) and m.ts >= $4 and m.ts < $5
         order by m.ts`
      : `select k.key, r.bucket as ts, r.avg as value, r.min, r.max
         from metric_rollups r join metric_keys k on k.id = r.metric_id
         where r.object_id = $1 and k.module = $2 and k.key = any($3) and r.res = $6
           and r.bucket >= $4 and r.bucket < $5
         order by r.bucket`;
  const params: unknown[] = [q.objectId, q.module, q.metrics, q.from, q.to];
  if (level !== "raw") params.push(level === "5m" ? 300 : 3600);
  const { rows } = await db.query<Point & { key: string }>(sql, params);
  const out: Record<string, Point[]> = Object.fromEntries(q.metrics.map((k) => [k, []]));
  for (const { key, ...p } of rows) out[key].push(p.min === undefined ? { ts: p.ts, value: p.value } : p);
  return { level, series: out };
}
