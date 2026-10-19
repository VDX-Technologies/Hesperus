// Push ingestion: archive every message as received, then normalize it through the source's
// module package into objects, metrics and events. A bad message is kept in the raw archive
// and reported; it never blocks the rest of the batch.
import { forTenant, type Db } from "./db";
import type { ModulePackage, Normalized } from "./package";
import { ValidationError } from "./package";
import type { RawMessage } from "./connectors";
import type { Source } from "./sources";
import { getSettings, num } from "./settings";
import { applyDerived, type DerivedState } from "./derived";
import { deviceConfig, evaluateRules, loadRules, type DeviceConfig, type Point } from "./rules";
import { runAlertHooks, type AlertTransition } from "./hooks";

export interface IngestResult {
  accepted: number;
  rejected: { index: number; error: string }[];
  metrics: number;
  events: number;
  alerts: { opened: number; resolved: number };
  /** Configs to forward to devices whose acknowledged version is out of date. */
  configs: ({ type: string; externalId: string } & DeviceConfig)[];
  /** Objects written by the batch. */
  objectIds: string[];
}

type Registry = { types: Map<string, string>; metrics: Map<string, number> };
const registries = new WeakMap<Db, Map<string, Registry>>();

/** Upserts the package's object types, event types and metric keys once per process and database. */
export async function registerPackage(db: Db, pkg: ModulePackage): Promise<Registry> {
  let byPkg = registries.get(db);
  if (!byPkg) registries.set(db, (byPkg = new Map()));
  const cached = byPkg.get(pkg.id);
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
  byPkg.set(pkg.id, reg);
  return reg;
}

/** Per-source token bucket (ingest.rate_per_min, ingest.burst). 0 = go on, else seconds to wait. */
export async function takeIngestToken(db: Db, sourceId: string, now = new Date()): Promise<number> {
  const { rows } = await db.query<{ wait: number }>(`select ingest_take($1, $2) wait`, [sourceId, now]);
  return Number(rows[0].wait);
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

  // 1. Immutable copy first: whatever happens next, the raw message is kept. A replay reads
  // from the archive, so it does not write it again.
  if (!opts.replay) await db.query(
    `insert into raw_inbox (tenant_id, source_id, received_at, body)
     select $1, $2, $3, b from jsonb_array_elements($4::jsonb) b`,
    [source.tenant_id, source.id, now, JSON.stringify(messages)],
  );

  const reg = await registerPackage(db, pkg);
  const result: IngestResult = {
    accepted: 0, rejected: [], metrics: 0, events: 0, alerts: { opened: 0, resolved: 0 }, configs: [], objectIds: [],
  };
  const items: Normalized[] = [];

  messages.forEach((m, index) => {
    try {
      const out = pkg.normalize(m);
      const list = Array.isArray(out) ? out : [out];
      for (const n of list) {
        if (!reg.types.has(n.object.type)) throw new ValidationError(`unknown object type "${n.object.type}"`);
        if (n.ts && !(n.ts instanceof Date && Number.isFinite(n.ts.getTime()))) throw new ValidationError("invalid ts");
        if (n.ts && n.ts.getTime() - now.getTime() > maxFuture) throw new ValidationError("ts is in the future");
      }
      items.push(...list);
      result.accepted++;
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      result.rejected.push({ index, error: e.message });
    }
  });

  // 2. Objects, once per (type, externalId); later messages win on name and properties.
  type Obj = {
    type: string; typeId: string; externalId: string; name?: string; properties: object; ts: Date; configAck?: number;
  };
  const objects = new Map<string, Obj>();
  for (const n of items) {
    const k = `${n.object.type}\u0000${n.object.externalId}`;
    const prev = objects.get(k);
    objects.set(k, {
      type: n.object.type,
      typeId: reg.types.get(n.object.type)!,
      externalId: n.object.externalId,
      name: n.object.name ?? prev?.name,
      properties: { ...prev?.properties, ...n.object.properties },
      ts: n.ts && prev && prev.ts > n.ts ? prev.ts : (n.ts ?? now),
      configAck: n.configAck ?? prev?.configAck,
    });
  }
  const objectIds = new Map<string, string>();
  const derivedState = new Map<string, DerivedState>();
  const pkgState = new Map<string, Record<string, unknown>>();
  for (const [k, o] of objects) {
    const { rows } = await db.query<{ id: string; state: { derived?: DerivedState; pkg?: Record<string, unknown> } }>(
      `insert into objects (tenant_id, type_id, external_id, name, properties, last_seen)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (tenant_id, type_id, external_id) do update set
         name = coalesce(excluded.name, objects.name),
         properties = objects.properties || excluded.properties,
         last_seen = greatest(objects.last_seen, excluded.last_seen)
       returning id, state`,
      [source.tenant_id, o.typeId, o.externalId, o.name ?? null, o.properties, o.ts],
    );
    objectIds.set(k, rows[0].id);
    derivedState.set(k, rows[0].state.derived ?? {});
    pkgState.set(k, rows[0].state.pkg ?? {});
  }
  result.objectIds = [...objectIds.values()];

  // Derived metrics and the package step, in time order so they see the previous point.
  if (pkg.derived?.length || pkg.step) {
    const ordered = [...items].sort((a, b) => (a.ts ?? now).getTime() - (b.ts ?? now).getTime());
    for (const n of ordered) {
      const k = `${n.object.type}\u0000${n.object.externalId}`;
      n.metrics = { ...n.metrics };
      if (pkg.derived?.length) applyDerived(pkg.derived, n.metrics, n.ts ?? now, derivedState.get(k)!);
      pkg.step?.(n.metrics, n.ts ?? now, pkgState.get(k)!);
    }
    for (const k of objects.keys()) {
      const st = { derived: derivedState.get(k)!, pkg: pkgState.get(k)! };
      if (Object.keys(st.derived).length || Object.keys(st.pkg).length) await db.query(
        `update objects set state = state || $2::jsonb where id = $1 and tenant_id = $3`, [objectIds.get(k), st, source.tenant_id],
      );
    }
  }

  // 3. Metrics in one statement; replays of the same (object, metric, ts) are ignored.
  const mObj: string[] = [], mKey: number[] = [], mTs: Date[] = [], mVal: number[] = [];
  const points: Point[] = [];
  for (const n of items) {
    const objectId = objectIds.get(`${n.object.type}\u0000${n.object.externalId}`)!;
    for (const [key, value] of Object.entries(n.metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const metricId = reg.metrics.get(key);
      if (metricId === undefined) continue; // undeclared metrics stay in the raw archive only
      mObj.push(objectId); mKey.push(metricId); mTs.push(n.ts ?? now); mVal.push(value);
      points.push({ objectId, type: n.object.type, metric: key, ts: n.ts ?? now, value });
    }
  }
  if (mObj.length) {
    const r = await db.query(
      `insert into metrics (tenant_id, object_id, metric_id, ts, value)
       select $1, * from unnest($2::uuid[], $3::smallint[], $4::timestamptz[], $5::float8[])
       on conflict do nothing`,
      [source.tenant_id, mObj, mKey, mTs, mVal],
    );
    result.metrics = r.rowCount ?? 0;
  }

  // 4. Events, linked to their object.
  const withEvents = opts.events ?? !opts.replay;
  for (const n of withEvents ? items : []) {
    for (const ev of n.events ?? []) {
      const { rows } = await db.query<{ id: string }>(
        `insert into events (tenant_id, ts, type, severity, payload, source_id, document_id) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [source.tenant_id, n.ts ?? now, `${pkg.id}.${ev.type}`, ev.severity, ev.payload ?? {}, source.id, opts.documentId ?? null],
      );
      await db.query(`insert into event_objects (tenant_id, event_id, object_id) values ($1, $2, $3)`, [
        source.tenant_id, rows[0].id, objectIds.get(`${n.object.type}\u0000${n.object.externalId}`),
      ]);
      result.events++;
    }
  }

  // 5. Rules and device configs. Replays rebuild data only: they never raise alerts.
  if (!opts.replay) {
    const rules = await loadRules(forTenant(db, source.tenant_id), pkg.id);
    let transitions: AlertTransition[] = [];
    if (rules.length) {
      transitions = await evaluateRules(db, source.tenant_id, rules, points);
      for (const t of transitions) result.alerts[t.kind]++;
      result.events += transitions.length;
    }
    for (const [k, o] of objects) {
      const cfg = deviceConfig(rules, o.type, objectIds.get(k)!);
      if (cfg && cfg.version !== o.configAck) result.configs.push({ type: o.type, externalId: o.externalId, ...cfg });
    }
    await runAlertHooks(transitions, db);
  }

  if (!opts.replay) await db.query(`update sources set last_seen = $2, last_error = $3 where id = $1 and tenant_id = $4`, [
    source.id, now, result.rejected.length ? `${result.rejected.length} rejected: ${result.rejected[0].error}` : null, source.tenant_id,
  ]);
  return result;
}
