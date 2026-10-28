import { createHash } from "node:crypto";
import { forTenant, inTransaction, type Db } from "./db";
import type { ModulePackage, Normalized } from "./package";
import { ValidationError } from "./package";
import type { RawMessage } from "./connectors";
import { markSeen, type Source } from "./sources";
import { getSettings, num } from "./settings";
import { applyDerived, type DerivedState } from "./derived";
import { deviceConfig, evaluateRules, loadRules, type DeviceConfig, type Point } from "./rules";
import { runAlertHooks, type AlertTransition } from "./hooks";
import "./push-notify";

export interface IngestResult {
  accepted: number;
  rejected: { index: number; error: string }[];
  metrics: number;
  events: number;
  alerts: { opened: number; resolved: number };
  configs: ({ type: string; externalId: string } & DeviceConfig)[];
  objectIds: string[];
  undeclared?: Record<string, number>;
}

type Registry = { types: Map<string, string>; metrics: Map<string, number> };
const registries = new WeakMap<Db, Map<string, Registry>>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function deviceProperties(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!properties || !("config" in properties)) return properties ?? {};
  return Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "config"));
}

export async function registerPackage(db: Db, pkg: ModulePackage, cache = true): Promise<Registry> {
  let byPkg = registries.get(db);
  if (cache && !byPkg) registries.set(db, (byPkg = new Map()));
  const key = `${pkg.id}\u0000${hash(canonical([pkg.objectTypes, pkg.eventTypes ?? [], pkg.metrics, pkg.derived ?? []]))}`;
  const cached = cache ? byPkg?.get(key) : undefined;
  if (cached) return cached;

  const reg: Registry = { types: new Map(), metrics: new Map() };
  for (const t of pkg.objectTypes) {
    const { rows } = await db.query<{ id: string }>(
      `insert into object_types (module, key, name, properties) values ($1, $2, $3, $4)
       on conflict (module, key) where tenant_id is null
       do update set name = excluded.name, properties = excluded.properties
       returning id`,
      [pkg.id, t.key, t.name, t.properties],
    );
    reg.types.set(t.key, rows[0].id);
  }
  for (const t of pkg.eventTypes ?? []) {
    await db.query(
      `insert into event_types (module, key, name, fields, subject, from_subject) values ($1, $2, $3, $4, $5, $6)
       on conflict (module, key) where tenant_id is null
       do update set name = excluded.name, fields = excluded.fields, subject = excluded.subject, from_subject = excluded.from_subject`,
      [pkg.id, t.key, t.name, t.fields, t.subject ?? null, t.fromSubject ?? {}],
    );
  }
  for (const m of [...pkg.metrics, ...(pkg.derived ?? [])]) {
    const { rows } = await db.query<{ id: number }>(
      `insert into metric_keys (module, key, unit, label) values ($1, $2, $3, $4)
       on conflict (module, key) do update set unit = excluded.unit, label = excluded.label
       returning id`,
      [pkg.id, m.key, m.unit ?? null, m.label ?? {}],
    );
    reg.metrics.set(m.key, rows[0].id);
  }
  if (cache) byPkg?.set(key, reg);
  return reg;
}

export async function takeIngestToken(db: Db, sourceId: string, now = new Date()): Promise<number> {
  const { rows } = await db.query<{ wait: number }>(`select ingest_take($1, $2) wait`, [sourceId, now]);
  return Number(rows[0].wait);
}

export type IngestCommit = { result: IngestResult; transitions: AlertTransition[] };

async function ingestPushWork(
  db: Db,
  source: Source,
  messages: RawMessage[],
  pkg: ModulePackage,
  now: Date,
  opts: { replay?: boolean; events?: boolean; documentId?: string },
  maxFuture: number,
  reg: Registry,
): Promise<IngestCommit> {
  const result: IngestResult = {
    accepted: 0, rejected: [], metrics: 0, events: 0, alerts: { opened: 0, resolved: 0 }, configs: [], objectIds: [],
  };
  const items: { n: Normalized; messageKey: string }[] = [];
  const occurrences = new Map<string, number>();

  messages.forEach((m, index) => {
    try {
      const out = pkg.normalize(m);
      const list = Array.isArray(out) ? out : [out];
      for (const n of list) {
        if (!reg.types.has(n.object.type)) throw new ValidationError(`unknown object type "${n.object.type}"`);
        if (n.ts && !(n.ts instanceof Date && Number.isFinite(n.ts.getTime()))) throw new ValidationError("invalid ts");
        if (n.ts && n.ts.getTime() - now.getTime() > maxFuture) throw new ValidationError("ts is in the future");
      }
      const fingerprint = hash(`${source.id}\u0000${canonical(m)}`);
      const occurrence = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occurrence + 1);
      list.forEach((n, normalizedIndex) => items.push({ n, messageKey: `${fingerprint}:${occurrence}:${normalizedIndex}` }));
      result.accepted++;
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      result.rejected.push({ index, error: e.message });
    }
  });

  type Obj = {
    type: string; typeId: string; externalId: string; name?: string; properties: object; ts: Date; configAck?: number;
  };
  const objects = new Map<string, Obj>();
  const byTime = [...items].sort((a, b) => (a.n.ts ?? now).getTime() - (b.n.ts ?? now).getTime());
  for (const { n } of byTime) {
    const k = `${n.object.type}\u0000${n.object.externalId}`;
    const prev = objects.get(k);
    objects.set(k, {
      type: n.object.type,
      typeId: reg.types.get(n.object.type)!,
      externalId: n.object.externalId,
      name: n.object.name ?? prev?.name,
      properties: { ...prev?.properties, ...deviceProperties(n.object.properties) },
      ts: n.ts && prev && prev.ts > n.ts ? prev.ts : (n.ts ?? now),
      configAck: n.configAck ?? prev?.configAck,
    });
  }
  const objectIds = new Map<string, string>();
  const derivedState = new Map<string, DerivedState>();
  const pkgState = new Map<string, Record<string, unknown>>();
  const stepConfig = new Map<string, Record<string, unknown>>();
  if (objects.size) {
    const entries = [...objects.entries()];
    const { rows: moduleRows } = await db.query<{ config: Record<string, unknown> | null }>(
      `select config from org_modules where org_id = $1 and module = $2 and enabled`,
      [source.tenant_id, pkg.id],
    );
    const organizationConfig = moduleRows[0]?.config ?? {};
    const { rows } = await db.query<{
      id: string; type_id: string; external_id: string;
      state: { derived?: DerivedState; pkg?: Record<string, unknown> };
      properties: Record<string, unknown>;
    }>(
      `insert into objects (tenant_id, type_id, external_id, name, properties, last_seen)
       select $1, x.type_id, x.external_id, x.name, x.properties, x.last_seen
         from unnest($2::uuid[], $3::text[], $4::text[], $5::jsonb[], $6::timestamptz[])
              as x(type_id, external_id, name, properties, last_seen)
       on conflict (tenant_id, type_id, external_id) do update set
         -- an older batch (late retransmission, replay) fills gaps but does not overwrite newer values
         name = case when objects.last_seen is null or excluded.last_seen >= objects.last_seen then coalesce(excluded.name, objects.name)
                     else coalesce(objects.name, excluded.name) end,
         properties = case when objects.last_seen is null or excluded.last_seen >= objects.last_seen then objects.properties || excluded.properties
                           else excluded.properties || objects.properties end,
         last_seen = greatest(objects.last_seen, excluded.last_seen)
       returning id, type_id, external_id, state, properties`,
      [source.tenant_id, entries.map(([, o]) => o.typeId), entries.map(([, o]) => o.externalId), entries.map(([, o]) => o.name ?? null),
        entries.map(([, o]) => o.properties), entries.map(([, o]) => o.ts)],
    );
    const typeNames = new Map(entries.map(([, o]) => [o.typeId, o.type]));
    for (const row of rows) {
      const k = `${typeNames.get(row.type_id)}\u0000${row.external_id}`;
      objectIds.set(k, row.id);
      derivedState.set(k, row.state.derived ?? {});
      pkgState.set(k, row.state.pkg ?? {});
      const objectConfig = row.properties?.config;
      stepConfig.set(k, {
        ...organizationConfig,
        ...(objectConfig && typeof objectConfig === "object" && !Array.isArray(objectConfig)
          ? objectConfig as Record<string, unknown>
          : {}),
      });
    }
  }
  result.objectIds = [...objectIds.values()];

  if (pkg.derived?.length || pkg.step) {
    const ordered = [...items].sort((a, b) => (a.n.ts ?? now).getTime() - (b.n.ts ?? now).getTime());
    for (const { n } of ordered) {
      const k = `${n.object.type}\u0000${n.object.externalId}`;
      n.metrics = { ...n.metrics };
      if (pkg.derived?.length) applyDerived(pkg.derived, n.metrics, n.ts ?? now, derivedState.get(k)!);
      pkg.step?.(n.metrics, n.ts ?? now, pkgState.get(k)!, {
        config: stepConfig.get(k) ?? {},
        properties: n.object.properties ?? {},
      });
    }
    const stateIds: string[] = [], stateValues: Record<string, unknown>[] = [];
    for (const k of objects.keys()) {
      const st = { derived: derivedState.get(k)!, pkg: pkgState.get(k)! };
      if (Object.keys(st.derived).length || Object.keys(st.pkg).length) {
        stateIds.push(objectIds.get(k)!);
        stateValues.push(st);
      }
    }
    if (stateIds.length) await db.query(
      `update objects o set state = o.state || x.state
         from unnest($2::uuid[], $3::jsonb[]) as x(id, state)
        where o.tenant_id = $1 and o.id = x.id`,
      [source.tenant_id, stateIds, stateValues],
    );
  }

  const mObj: string[] = [], mKey: number[] = [], mTs: Date[] = [], mVal: number[] = [];
  const points: Point[] = [];
  for (const { n } of items) {
    const objectId = objectIds.get(`${n.object.type}\u0000${n.object.externalId}`)!;
    for (const [key, value] of Object.entries(n.metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const metricId = reg.metrics.get(key);
      if (metricId === undefined) {
        (result.undeclared ??= {})[key] = (result.undeclared[key] ?? 0) + 1;
        continue;
      }
      mObj.push(objectId); mKey.push(metricId); mTs.push(n.ts ?? now); mVal.push(value);
      points.push({ objectId, type: n.object.type, metric: key, ts: n.ts ?? now, value });
    }
  }
  if (mObj.length) {
    const r = await db.query(
      `insert into metrics (tenant_id, object_id, metric_id, ts, value, document_id)
       select $1, x.*, $6 from unnest($2::uuid[], $3::smallint[], $4::timestamptz[], $5::float8[])
         as x(object_id, metric_id, ts, value)
       on conflict do nothing`,
      [source.tenant_id, mObj, mKey, mTs, mVal, opts.documentId ?? null],
    );
    result.metrics = r.rowCount ?? 0;
  }

  const withEvents = opts.events ?? !opts.replay;
  if (withEvents) {
    const idempotencyKeys: string[] = [], timestamps: Date[] = [], eventTypes: string[] = [];
    const severities: string[] = [], payloads: Record<string, unknown>[] = [], eventObjectIds: string[] = [];
    for (const { n, messageKey } of items) for (const [eventIndex, ev] of (n.events ?? []).entries()) {
      idempotencyKeys.push(hash(`${messageKey}:${eventIndex}`));
      timestamps.push(n.ts ?? now);
      eventTypes.push(`${pkg.id}.${ev.type}`);
      severities.push(ev.severity);
      payloads.push(ev.payload ?? {});
      eventObjectIds.push(objectIds.get(`${n.object.type}\u0000${n.object.externalId}`)!);
    }
    if (idempotencyKeys.length) {
      const { rows } = await db.query<{ count: number }>(
        `with input as (
           select * from unnest($2::text[], $3::timestamptz[], $4::text[], $5::text[], $6::jsonb[], $7::uuid[])
             as x(idempotency_key, ts, type, severity, payload, object_id)
         ), inserted as (
           insert into events (tenant_id, ts, type, severity, payload, source_id, document_id, idempotency_key)
           select $1, x.ts, x.type, x.severity, x.payload, $8, $9, x.idempotency_key from input x
           on conflict (tenant_id, source_id, idempotency_key) where idempotency_key is not null do nothing
           returning id, idempotency_key
         ), linked as (
           insert into event_objects (tenant_id, event_id, object_id)
           select $1, i.id, x.object_id from inserted i join input x using (idempotency_key)
           on conflict (event_id, object_id) do nothing
           returning event_id
         )
         select count(*)::int count from inserted`,
        [source.tenant_id, idempotencyKeys, timestamps, eventTypes, severities, payloads, eventObjectIds, source.id, opts.documentId ?? null],
      );
      result.events = rows[0]?.count ?? 0;
    }
  }

  let transitions: AlertTransition[] = [];
  if (!opts.replay) {
    const rules = await loadRules(forTenant(db, source.tenant_id), pkg.id);
    if (rules.length) {
      transitions = await evaluateRules(db, source.tenant_id, rules, points);
      for (const t of transitions) result.alerts[t.kind]++;
      result.events += transitions.length;
    }
    for (const [k, o] of objects) {
      const cfg = deviceConfig(rules, o.type, objectIds.get(k)!);
      if (cfg && cfg.version !== o.configAck) result.configs.push({ type: o.type, externalId: o.externalId, ...cfg });
    }
  }

  if (!opts.replay) {
    const undeclared = Object.keys(result.undeclared ?? {});
    const error = result.rejected.length ? `${result.rejected.length} rejected: ${result.rejected[0].error}`
      : undeclared.length ? `undeclared metrics ignored: ${undeclared.slice(0, 10).join(", ")}` : null;
    await markSeen(db, source, error, now);
  }
  return { result, transitions };
}

export async function ingestPushInTransaction(
  db: Db,
  source: Source,
  messages: RawMessage[],
  pkg: ModulePackage,
  now = new Date(),
  opts: { replay?: boolean; events?: boolean; documentId?: string } = {},
): Promise<IngestCommit> {
  const settings = await getSettings(db);
  const maxBatch = num(settings, "ingest.max_batch", 500);
  if (messages.length > maxBatch) throw new ValidationError(`batch too large (max ${maxBatch})`);
  const maxFuture = num(settings, "ingest.max_future_s", 300) * 1000;
  if (!opts.replay) await db.query(
    `insert into raw_inbox (tenant_id, source_id, received_at, body)
     select $1, $2, $3, b from jsonb_array_elements($4::jsonb) b`,
    [source.tenant_id, source.id, now, JSON.stringify(messages)],
  );
  const reg = await registerPackage(db, pkg, false);
  return ingestPushWork(db, source, messages, pkg, now, opts, maxFuture, reg);
}

export async function dispatchIngestHooks(db: Db, transitions: AlertTransition[]) {
  await runAlertHooks(transitions, db);
}

export async function ingestPush(
  db: Db,
  source: Source,
  messages: RawMessage[],
  pkg: ModulePackage,
  now = new Date(),
  opts: { replay?: boolean; events?: boolean; documentId?: string } = {},
): Promise<IngestResult> {
  const settings = await getSettings(db);
  const maxBatch = num(settings, "ingest.max_batch", 500);
  if (messages.length > maxBatch) throw new ValidationError(`batch too large (max ${maxBatch})`);
  const maxFuture = num(settings, "ingest.max_future_s", 300) * 1000;
  if (!opts.replay) await db.query(
    `insert into raw_inbox (tenant_id, source_id, received_at, body)
     select $1, $2, $3, b from jsonb_array_elements($4::jsonb) b`,
    [source.tenant_id, source.id, now, JSON.stringify(messages)],
  );
  const reg = await registerPackage(db, pkg);
  const committed = await inTransaction(db, (connection) =>
    ingestPushWork(connection, source, messages, pkg, now, opts, maxFuture, reg));
  if (!opts.replay) await runAlertHooks(committed.transitions, db);
  return committed.result;
}
