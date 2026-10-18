// Threshold rules: evaluated on every ingested point, they open and resolve alerts.
// Rules with the same key form a family; for a given object the rule targeting that object
// wins over the type-wide one, which is how per-device thresholds are expressed. Rules marked
// push_to_device also make up the config sent back to the device.
import type { Db, TenantDb } from "./db";
import type { AlertTransition } from "./hooks";

export type Op = ">" | ">=" | "<" | "<=";

export interface Rule {
  id: string;
  key: string;
  name: string | null;
  metric: string;
  object_type: string | null;
  object_id: string | null;
  op: Op;
  threshold: number;
  hysteresis: number;
  for_s: number;
  severity: "info" | "warn" | "alarm";
  push_to_device: boolean;
}

export interface Point {
  objectId: string;
  type: string;
  metric: string;
  ts: Date;
  value: number;
}

export async function loadRules(db: TenantDb, module: string): Promise<Rule[]> {
  const { rows } = await db.query<Rule>(
    `select id, key, name, metric, object_type, object_id, op, threshold, hysteresis, for_s, severity, push_to_device
     from rules where tenant_id = $1 and module = $2 and enabled`,
    [db.tenantId, module],
  );
  return rows;
}

/** The rules that apply to one object: per family, its own override or else the type-wide rule. */
export function effectiveRules(rules: Rule[], type: string, objectId: string): Rule[] {
  const byKey = new Map<string, Rule>();
  for (const r of rules) {
    if (r.object_id ? r.object_id !== objectId : r.object_type !== null && r.object_type !== type) continue;
    const cur = byKey.get(r.key);
    if (!cur || (!cur.object_id && r.object_id)) byKey.set(r.key, r);
  }
  return [...byKey.values()];
}

const cmp = (op: Op, v: number, t: number) =>
  op === ">" ? v > t : op === ">=" ? v >= t : op === "<" ? v < t : v <= t;

/** Still active: the value has not come back past the threshold by the hysteresis band. */
const stillActive = (r: Rule, v: number) =>
  cmp(r.op, v, r.op.startsWith(">") ? r.threshold - r.hysteresis : r.threshold + r.hysteresis);

const worse = (r: Rule, a: number, b: number) => (r.op.startsWith(">") ? Math.max(a, b) : Math.min(a, b));

/** Evaluates points in time order. Points not newer than the last one evaluated are ignored. */
export async function evaluateRules(
  db: Db, tenantId: string, rules: Rule[], points: Point[],
): Promise<AlertTransition[]> {
  const pairs: { rule: Rule; pts: Point[] }[] = [];
  const byObjMetric = new Map<string, Point[]>();
  for (const p of points) {
    const k = `${p.objectId}\u0000${p.metric}`;
    byObjMetric.get(k)?.push(p) ?? byObjMetric.set(k, [p]);
  }
  for (const pts of byObjMetric.values()) {
    const { objectId, type, metric } = pts[0];
    pts.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    for (const rule of effectiveRules(rules, type, objectId)) if (rule.metric === metric) pairs.push({ rule, pts });
  }
  if (!pairs.length) return [];

  const ruleIds = pairs.map((p) => p.rule.id), objIds = pairs.map((p) => p.pts[0].objectId);
  const { rows: states } = await db.query<{ rule_id: string; object_id: string; breach_since: Date | null; last_ts: Date }>(
    `select s.* from rule_state s join unnest($1::uuid[], $2::uuid[]) u(r, o) on s.rule_id = u.r and s.object_id = u.o`,
    [ruleIds, objIds],
  );
  const { rows: active } = await db.query<{ id: string; rule_id: string; object_id: string; peak: number }>(
    `select a.id, a.rule_id, a.object_id, a.peak from object_alerts a
     join unnest($1::uuid[], $2::uuid[]) u(r, o) on a.rule_id = u.r and a.object_id = u.o
     where a.tenant_id = $3 and a.status <> 'resolved'`,
    [ruleIds, objIds, tenantId],
  );
  const key = (r: string, o: string) => `${r}\u0000${o}`;
  const stateOf = new Map(states.map((s) => [key(s.rule_id, s.object_id), s]));
  const alertOf = new Map(active.map((a) => [key(a.rule_id, a.object_id), a]));

  const out: AlertTransition[] = [];
  for (const { rule, pts } of pairs) {
    const objectId = pts[0].objectId, k = key(rule.id, objectId);
    const st = stateOf.get(k);
    let since = st?.breach_since ?? null, lastTs = st?.last_ts ?? null, lastValue: number | null = null;
    let alert = alertOf.get(k);

    for (const p of pts) {
      if (lastTs && p.ts <= lastTs) continue;
      lastTs = p.ts; lastValue = p.value;
      if (alert) {
        if (stillActive(rule, p.value)) {
          alert.peak = worse(rule, alert.peak, p.value);
          continue;
        }
        await db.query(`update object_alerts set status = 'resolved', resolved_at = $2, peak = $3 where id = $1 and tenant_id = $4`, [
          alert.id, p.ts, alert.peak, tenantId,
        ]);
        out.push(await transition(db, "resolved", tenantId, alert.id, objectId, rule, p));
        alert = undefined; since = null;
      } else if (cmp(rule.op, p.value, rule.threshold)) {
        since ??= p.ts;
        if (p.ts.getTime() - since.getTime() < rule.for_s * 1000) continue;
        const { rows } = await db.query<{ id: string }>(
          `insert into object_alerts (tenant_id, rule_id, object_id, severity, title, opened_at, value, peak)
           values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
          [tenantId, rule.id, objectId, rule.severity, rule.name ?? `${rule.metric} ${rule.op} ${rule.threshold}`, p.ts, p.value],
        );
        alert = { id: rows[0].id, rule_id: rule.id, object_id: objectId, peak: p.value };
        out.push(await transition(db, "opened", tenantId, alert.id, objectId, rule, p));
      } else {
        since = null;
      }
    }
    if (lastValue === null) continue;
    if (alert) await db.query(`update object_alerts set peak = $2 where id = $1 and tenant_id = $3`, [alert.id, alert.peak, tenantId]);
    await db.query(
      `insert into rule_state (rule_id, object_id, breach_since, last_ts, last_value) values ($1, $2, $3, $4, $5)
       on conflict (rule_id, object_id) do update set
         breach_since = excluded.breach_since, last_ts = excluded.last_ts, last_value = excluded.last_value`,
      [rule.id, objectId, since, lastTs, lastValue],
    );
  }
  return out;
}

async function transition(
  db: Db, kind: "opened" | "resolved", tenantId: string, alertId: string, objectId: string, rule: Rule, p: Point,
): Promise<AlertTransition> {
  const { rows } = await db.query<{ id: string }>(
    `insert into events (tenant_id, ts, type, severity, payload) values ($1, $2, $3, $4, $5) returning id`,
    [tenantId, p.ts, `alert.${kind}`, kind === "opened" ? rule.severity : "info",
      { alert_id: alertId, rule: rule.key, metric: rule.metric, value: p.value, threshold: rule.threshold }],
  );
  await db.query(`insert into event_objects (tenant_id, event_id, object_id) values ($1, $2, $3)`, [tenantId, rows[0].id, objectId]);
  return { kind, alertId, tenantId, objectId, ruleKey: rule.key, severity: rule.severity, value: p.value, ts: p.ts };
}

export interface DeviceConfig {
  version: number;
  thresholds: Record<string, { metric: string; op: Op; threshold: number; hysteresis: number; for_s: number }>;
}

/** Thresholds a device should apply locally; the version changes whenever any of them does. */
export function deviceConfig(rules: Rule[], type: string, objectId: string): DeviceConfig | null {
  const own = effectiveRules(rules, type, objectId).filter((r) => r.push_to_device).sort((a, b) => a.key.localeCompare(b.key));
  if (!own.length) return null;
  const thresholds = Object.fromEntries(own.map((r) => [r.key, {
    metric: r.metric, op: r.op, threshold: r.threshold, hysteresis: r.hysteresis, for_s: r.for_s,
  }]));
  return { version: fnv1a(JSON.stringify(thresholds)), thresholds };
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export type RuleSpec = Pick<Rule, "key" | "metric" | "op" | "threshold" | "severity"> &
  Partial<Pick<Rule, "name" | "object_type" | "hysteresis" | "for_s" | "push_to_device">>;

/** Creates or updates rules by family; with objectId they become that object's overrides. */
export async function upsertRules(
  db: TenantDb, module: string, specs: RuleSpec[], objectId: string | null = null,
): Promise<number> {
  for (const r of specs) await db.query(
    `insert into rules (tenant_id, key, name, module, metric, object_type, object_id, op, threshold, hysteresis,
                        for_s, severity, push_to_device)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (tenant_id, key, coalesce(object_id, '00000000-0000-0000-0000-000000000000'::uuid))
     do update set name = excluded.name, metric = excluded.metric, object_type = excluded.object_type,
       op = excluded.op, threshold = excluded.threshold, hysteresis = excluded.hysteresis,
       for_s = excluded.for_s, severity = excluded.severity, push_to_device = excluded.push_to_device`,
    [db.tenantId, r.key, r.name ?? null, module, r.metric, r.object_type ?? null, objectId, r.op, r.threshold,
      r.hysteresis ?? 0, r.for_s ?? 0, r.severity, r.push_to_device ?? false],
  );
  return specs.length;
}
