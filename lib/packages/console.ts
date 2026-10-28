import "server-only";
import type { TenantDb } from "../engine/db";
import { getPackageDef } from "./ui";
import type { Locale, Status } from "./types";

export interface ConsoleObject {
  id: string;
  externalId: string | null;
  name: string;
  type: string;
  placeId: string | null;
  placePath: string[];
  properties: Record<string, unknown>;
  state: Record<string, unknown>;
  lastSeen: string | null;
  status: Status;
  values: Record<string, number | null>;
}

export interface ConsoleAlert {
  id: number;
  objectId: string;
  object: string;
  severity: "info" | "warn" | "alarm";
  status: "open" | "acknowledged" | "resolved";
  openedAt: string;
  resolvedAt: string | null;
  text: string;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function listObjects(db: TenantDb, module: string, objectId?: string): Promise<ConsoleObject[]> {
  const pkg = getPackageDef(module);
  const { rows } = await db.query<{
    id: string; external_id: string | null; name: string | null; type: string; properties: Record<string, unknown>;
    state: Record<string, unknown>; last_seen: Date | null; place_id: string | null; place_path: string[] | null; worst: string | null;
  }>(
    `select o.id, o.external_id, o.name, t.key type, o.properties, o.state, o.last_seen, l.dst_id place_id,
            (with recursive up(id, name, depth) as (
               select p.id, p.name, 0 from objects p where p.tenant_id = o.tenant_id and p.id = l.dst_id
               union all
               select q.id, q.name, up.depth + 1 from up
               join links pl on pl.tenant_id = o.tenant_id and pl.type = 'part_of' and pl.src_id = up.id
               join objects q on q.tenant_id = o.tenant_id and q.id = pl.dst_id
               where up.depth < 32
             ) select array_agg(name order by depth desc) from up) place_path,
            (select a.severity from object_alerts a where a.object_id = o.id and a.status <> 'resolved'
             order by case a.severity when 'alarm' then 0 when 'warn' then 1 else 2 end limit 1) worst
     from objects o join object_types t on t.id = o.type_id
     left join links l on l.tenant_id = o.tenant_id and l.type = 'located_in' and l.src_id = o.id
     where o.tenant_id = $1 and t.module = $2 and ($3::uuid is null or o.id = $3)
     order by coalesce(o.name, o.external_id)`,
    [db.tenantId, module, objectId ?? null],
  );
  if (!rows.length) return [];
  const vals = await db.query<{ object_id: string; key: string; value: number }>(
    `select distinct on (m.object_id, m.metric_id) m.object_id, k.key, m.value
     from metrics m join metric_keys k on k.id = m.metric_id
     where m.tenant_id = $1 and m.object_id = any($2) and m.ts > now() - interval '1 day'
     order by m.object_id, m.metric_id, m.ts desc`,
    [db.tenantId, rows.map((r) => r.id)],
  );
  const offlineMs = (pkg?.offlineAfterS ?? 300) * 1000;
  return rows.map((r) => {
    const values: Record<string, number | null> = {};
    for (const v of vals.rows) if (v.object_id === r.id) values[v.key] = v.value;
    const status: Status =
      !r.last_seen || Date.now() - r.last_seen.getTime() > offlineMs ? "offline" : r.worst === "alarm" ? "alarm" : r.worst === "warn" ? "warn" : "ok";
    return {
      id: r.id,
      externalId: r.external_id,
      name: r.name ?? r.external_id ?? r.id.slice(0, 8),
      type: r.type,
      placeId: r.place_id,
      placePath: r.place_path ?? [],
      properties: r.properties,
      state: r.state,
      lastSeen: iso(r.last_seen),
      status,
      values,
    };
  });
}

export async function listAlerts(
  db: TenantDb, locale: Locale, q: { objectId?: string; history?: boolean; limit?: number } = {},
): Promise<ConsoleAlert[]> {
  const { rows } = await db.query<{
    id: string; object_id: string; object: string | null; severity: ConsoleAlert["severity"]; status: ConsoleAlert["status"];
    opened_at: Date; resolved_at: Date | null; value: number | null; peak: number | null; title: string | null;
    key: string | null; threshold: number | null; module: string | null;
  }>(
    `select a.id, a.object_id, coalesce(o.name, o.external_id) object, a.severity, a.status, a.opened_at, a.resolved_at,
            a.value, a.peak, a.title, r.key, r.threshold, r.module
     from object_alerts a join objects o on o.tenant_id = a.tenant_id and o.id = a.object_id left join rules r on r.id = a.rule_id
     where a.tenant_id = $1 and ($2::uuid is null or a.object_id = $2)
       and (a.status <> 'resolved') = not $3
     order by case a.severity when 'alarm' then 0 when 'warn' then 1 else 2 end, a.opened_at desc
     limit $4`,
    [db.tenantId, q.objectId ?? null, !!q.history, q.limit ?? 200],
  );
  return rows.map((r) => {
    const pkg = r.module ? getPackageDef(r.module) : null;
    const key = r.key ?? r.title ?? "";
    return {
      id: Number(r.id),
      objectId: r.object_id,
      object: r.object ?? "",
      severity: r.severity,
      status: r.status,
      openedAt: r.opened_at.toISOString(),
      resolvedAt: iso(r.resolved_at),
      text: pkg ? pkg.alertText(key, { value: r.peak ?? r.value, limit: r.threshold }, locale) : (r.title ?? key),
    };
  });
}

export async function countOpenAlerts(db: TenantDb) {
  return (await countOpenAlertSummary(db)).open;
}

export async function countOpenAlertSummary(db: TenantDb) {
  const { rows } = await db.query<{ open: number; alarms: number; warnings: number }>(
    `select count(*)::int open,
            count(*) filter (where severity = 'alarm')::int alarms,
            count(*) filter (where severity = 'warn')::int warnings
       from object_alerts where tenant_id = $1 and status = 'open'`,
    [db.tenantId],
  );
  return rows[0];
}
