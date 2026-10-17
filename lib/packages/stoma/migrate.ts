// One-off move of an organization's Stoma data from the legacy tables (gateways, devices,
// readings, alerts) into the engine. Idempotent: every step skips what is already there, so it
// can be re-run after a partial failure. The legacy tables are only read, never changed.
import type { Db } from "../../engine/db";
import { registerPackage } from "../../engine/ingest";
import { upsertRules, type RuleSpec } from "../../engine/rules";
import { legacyRuleKey, rulesFromConfig, stomaPackage, type StomaConfig } from ".";

export interface MigrationReport {
  sources: number;
  objects: number;
  readings: number;
  metrics: number;
  rules: number;
  alerts: number;
}

const sameRule = (a: RuleSpec, b: RuleSpec) => a.op === b.op && a.threshold === b.threshold && a.metric === b.metric;

/** Counts what would be moved, without writing. `metrics` is an upper bound (numeric values). */
export async function planOrg(db: Db, orgId: string): Promise<MigrationReport> {
  const { rows: [r] } = await db.query(
    `select (select count(*) from gateways where org_id = $1)::int as sources,
            (select count(*) from devices where org_id = $1 and module = 'stoma')::int as objects,
            (select count(*) from readings r join devices d on d.id = r.device_id
              where r.org_id = $1 and d.module = 'stoma')::int as readings,
            (select count(*) from readings r join devices d on d.id = r.device_id,
              jsonb_each(r.values) v where r.org_id = $1 and d.module = 'stoma'
              and jsonb_typeof(v.value) = 'number')::int as metrics,
            (select count(*) from devices where org_id = $1 and module = 'stoma' and config <> '{}')::int as rules,
            (select count(*) from alerts where org_id = $1 and code like 'stoma.%')::int as alerts`,
    [orgId],
  );
  return r;
}

export async function migrateOrg(db: Db, orgId: string): Promise<MigrationReport> {
  const reg = await registerPackage(db, stomaPackage);
  const typeId = reg.types.get("node")!;
  const rep: MigrationReport = { sources: 0, objects: 0, readings: 0, metrics: 0, rules: 0, alerts: 0 };

  // Gateways become push sources; same sha256, so the existing keys keep working.
  rep.sources = (await db.query(
    `insert into sources (tenant_id, name, connector, module, config, token_hash, token_hint, last_seen)
     select g.org_id, g.name, 'push', 'stoma', jsonb_build_object('gateway_id', g.id), g.key_hash, g.key_hint, g.last_seen
     from gateways g where g.org_id = $1
     on conflict (token_hash) do nothing`,
    [orgId],
  )).rowCount ?? 0;

  rep.objects = (await db.query(
    `insert into objects (tenant_id, type_id, external_id, name, properties, last_seen, created_at)
     select d.org_id, $2, d.serial, d.name,
            jsonb_strip_nulls(jsonb_build_object('legacy_device_id', d.id::text, 'zone_id', d.zone_id::text)),
            d.last_seen, d.created_at
     from devices d where d.org_id = $1 and d.module = 'stoma'
     on conflict (tenant_id, type_id, external_id) do nothing`,
    [orgId, typeId],
  )).rowCount ?? 0;

  // History: every numeric value of every reading; older days land in metrics_default.
  const { rows: [m] } = await db.query(
    `with ins as (
       insert into metrics (tenant_id, object_id, metric_id, ts, value)
       select r.org_id, o.id, k.id, r.ts, (v.value)::text::float8
       from readings r
       join devices d on d.id = r.device_id and d.module = 'stoma'
       join objects o on o.tenant_id = r.org_id and o.type_id = $2 and o.external_id = d.serial
       cross join lateral jsonb_each(r.values) v
       join metric_keys k on k.module = 'stoma' and k.key = v.key
       where r.org_id = $1 and jsonb_typeof(v.value) = 'number'
       on conflict do nothing returning 1)
     select count(*)::int as n from ins`,
    [orgId, typeId],
  );
  rep.metrics = m.n;
  rep.readings = (await db.query(`select count(*)::int as n from readings where org_id = $1`, [orgId])).rows[0].n;

  // The counters carry on from the last reading (only for objects without engine state yet).
  await db.query(
    `update objects o set state = o.state || jsonb_build_object('pkg', jsonb_strip_nulls(jsonb_build_object(
       'ts', (extract(epoch from l.ts) * 1000)::bigint,
       'rh', l.values->'rh',
       'wet_h', l.meta->'wet_h', 'humid_h', l.meta->'humid_h',
       'pm_day', l.meta->'pm_day', 'pm_base', l.meta->'pm_base', 'pm_hours', l.meta->'pm_hours',
       'irrigation_until', case when l.meta->>'irrigation_until' is not null
         then to_jsonb((extract(epoch from (l.meta->>'irrigation_until')::timestamptz) * 1000)::bigint) end)))
     from devices d
     cross join lateral (select ts, values, meta from readings where device_id = d.id order by ts desc limit 1) l
     where d.org_id = $1 and d.module = 'stoma'
       and o.tenant_id = d.org_id and o.type_id = $2 and o.external_id = d.serial and not (o.state ? 'pkg')`,
    [orgId, typeId],
  );

  // Thresholds: the company's become type-wide rules, a device's own only where they differ.
  const { rows: [om] } = await db.query<{ config: Partial<StomaConfig> | null }>(
    `select config from org_modules where org_id = $1 and module = 'stoma'`, [orgId],
  );
  const base = rulesFromConfig(om?.config ?? {});
  rep.rules += await upsertRules(db, orgId, "stoma", base);
  const { rows: devs } = await db.query<{ id: string; config: Partial<StomaConfig> }>(
    `select o.id, d.config from devices d
     join objects o on o.tenant_id = d.org_id and o.type_id = $2 and o.external_id = d.serial
     where d.org_id = $1 and d.module = 'stoma' and d.config <> '{}'`,
    [orgId, typeId],
  );
  for (const d of devs) {
    const own = rulesFromConfig({ ...(om?.config ?? {}), ...d.config }).filter((r, i) => !sameRule(r, base[i]));
    if (own.length) rep.rules += await upsertRules(db, orgId, "stoma", own, d.id);
  }

  // Alerts, with their history; open ones also seed the rule state so they resolve normally.
  const { rows: alerts } = await db.query<{ code: string; level: string; ts: Date; resolved_at: Date | null; object_id: string }>(
    `select a.code, a.level::text, a.ts, a.resolved_at, o.id as object_id from alerts a
     join devices d on d.id = a.device_id
     join objects o on o.tenant_id = d.org_id and o.type_id = $2 and o.external_id = d.serial
     where a.org_id = $1 and a.code like 'stoma.%' order by a.ts`,
    [orgId, typeId],
  );
  for (const a of alerts) {
    const key = legacyRuleKey(a.code.slice("stoma.".length), a.level);
    const { rows: ins } = await db.query<{ rule_id: string }>(
      `with r as (
         select id, severity, name from rules
         where tenant_id = $1 and key = $2 and (object_id = $3 or object_id is null)
         order by object_id nulls last limit 1)
       insert into object_alerts (tenant_id, rule_id, object_id, severity, status, title, opened_at, resolved_at)
       select $1, r.id, $3, r.severity, case when $5::timestamptz is null then 'open' else 'resolved' end, r.name, $4, $5
       from r
       where not exists (select 1 from object_alerts x where x.rule_id = r.id and x.object_id = $3 and x.opened_at = $4)
         and ($5::timestamptz is not null or not exists (select 1 from object_alerts x
           where x.rule_id = r.id and x.object_id = $3 and x.status <> 'resolved'))
       returning rule_id`,
      [orgId, key, a.object_id, a.ts, a.resolved_at],
    );
    if (!ins.length) continue;
    rep.alerts++;
    if (!a.resolved_at) await db.query(
      `insert into rule_state (rule_id, object_id, breach_since, last_ts) values ($1, $2, $3, $3) on conflict do nothing`,
      [ins[0].rule_id, a.object_id, a.ts],
    );
  }
  return rep;
}
