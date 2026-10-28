import type { Db } from "./db";
import type { ObjectStore } from "./store";
import type { ModulePackage } from "./package";
import type { Source } from "./sources";
import { readArchive } from "./archive";
import { ingestPush, type IngestResult } from "./ingest";

export interface ReplayOptions {
  from?: string;
  events?: boolean;
  dryRun?: boolean;
}

export async function replaySource(
  db: Db,
  store: ObjectStore,
  source: Source,
  pkg: ModulePackage,
  o: ReplayOptions = {},
): Promise<{ objects: number; total: IngestResult }> {
  if (source.connector === "manual") throw new Error("manual sources are not replayed");
  const keys = await store.list(`raw/${source.tenant_id}/${source.id}/${o.from ?? ""}`);
  const total: IngestResult = {
    accepted: 0, rejected: [], metrics: 0, events: 0, alerts: { opened: 0, resolved: 0 }, configs: [], objectIds: [],
  };
  for (const key of keys) {
    const gz = await store.get(key);
    if (!gz) continue;
    const batches = new Map<string, Record<string, unknown>[]>();
    for (const l of readArchive(gz)) batches.set(l.received_at, [...(batches.get(l.received_at) ?? []), l.body]);
    for (const [at, msgs] of batches) {
      if (o.dryRun) {
        total.accepted += msgs.length;
        continue;
      }
      const r = await ingestPush(db, source, msgs, pkg, new Date(at), { replay: true, events: o.events });
      total.accepted += r.accepted;
      total.metrics += r.metrics;
      total.events += r.events;
      total.rejected.push(...r.rejected.map((x) => ({ ...x, error: `${key}: ${x.error}` })));
    }
  }
  return { objects: keys.length, total };
}
