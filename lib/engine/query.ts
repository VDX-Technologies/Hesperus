import type { Db, TenantDb } from "./db";
import { getSettings, num } from "./settings";

export type Level = "raw" | "5m" | "1h";

export interface Point {
  ts: Date;
  value: number;
  min?: number;
  max?: number;
}

export interface MultiObjectPoint {
  ts: Date;
  objectId: string;
  key: string;
  value: number;
  min: number;
  max: number;
}

export async function pickLevel(db: Db, from: Date, to: Date): Promise<Level> {
  const s = await getSettings(db);
  const hours = (to.getTime() - from.getTime()) / 3_600_000;
  if (hours <= num(s, "query.raw_max_hours", 24)) return "raw";
  if (hours <= num(s, "query.rollup_5m_max_days", 7) * 24) return "5m";
  return "1h";
}

export async function series(
  db: TenantDb,
  q: { objectId: string; module: string; metrics: string[]; from: Date; to: Date; level?: Level },
): Promise<{ level: Level; series: Record<string, Point[]> }> {
  const level = q.level ?? (await pickLevel(db.shared, q.from, q.to));
  const sql =
    level === "raw"
      ? `select k.key, m.ts, m.value from metrics m join metric_keys k on k.id = m.metric_id
         where m.tenant_id = $1 and m.object_id = $2 and k.module = $3 and k.key = any($4) and m.ts >= $5 and m.ts < $6
         order by m.ts`
      : `select k.key, r.bucket as ts, r.avg as value, r.min, r.max
         from metric_rollups r join metric_keys k on k.id = r.metric_id
         where r.tenant_id = $1 and r.object_id = $2 and k.module = $3 and k.key = any($4) and r.res = $7
           and r.bucket >= $5 and r.bucket < $6
         order by r.bucket`;
  const params: unknown[] = [db.tenantId, q.objectId, q.module, q.metrics, q.from, q.to];
  if (level !== "raw") params.push(level === "5m" ? 300 : 3600);
  const { rows } = await db.query<Point & { key: string }>(sql, params);
  const out: Record<string, Point[]> = Object.fromEntries(q.metrics.map((k) => [k, []]));
  for (const { key, ...p } of rows) out[key].push(p.min === undefined ? { ts: p.ts, value: p.value } : p);
  return { level, series: out };
}

export async function multiObjectSeries(
  db: TenantDb,
  q: { objectIds: string[]; module: string; metrics: string[]; from: Date; to: Date },
): Promise<MultiObjectPoint[]> {
  if (!q.objectIds.length || !q.metrics.length) return [];
  const { rows } = await db.query<MultiObjectPoint>(
    `select m.object_id "objectId", k.key, date_bin('5 minutes', m.ts, 'epoch') ts,
            avg(m.value)::float8 value, min(m.value)::float8 min, max(m.value)::float8 max
       from metrics m join metric_keys k on k.id = m.metric_id
      where m.tenant_id = $1 and m.object_id = any($2::uuid[]) and k.module = $3
        and k.key = any($4::text[]) and m.ts >= $5 and m.ts < $6
      group by m.object_id, k.key, date_bin('5 minutes', m.ts, 'epoch')
      order by ts, m.object_id, k.key`,
    [db.tenantId, q.objectIds, q.module, q.metrics, q.from, q.to],
  );
  return rows;
}
