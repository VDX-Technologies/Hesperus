// Replays archived raw messages through the current package. Metrics and objects are
// idempotent; events are only recreated on request, since they are not.
import type { Db } from "./db";
import type { ObjectStore } from "./store";
import type { ModulePackage } from "./package";
import type { Source } from "./sources";
import { readArchive } from "./archive";
import { ingestPush, type IngestResult } from "./ingest";

export interface ReplayOptions {
  /** Archive key prefix below raw/{tenant}/{source}/, e.g. "2026/10" or "2026/10/17/08". */
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
  const keys = await store.list(`raw/${source.tenant_id}/${source.id}/${o.from ?? ""}`);
  const total: IngestResult = { accepted: 0, rejected: [], metrics: 0, events: 0 };
  for (const key of keys) {
    const gz = await store.get(key);
    if (!gz) continue;
    // Messages pushed together share received_at, which is their fallback timestamp.
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
