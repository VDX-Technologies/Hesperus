import { gunzipSync, gzipSync } from "node:zlib";
import type { Pool } from "pg";
import type { ObjectStore } from "./store";
import { tx } from "./db";

export interface FlushResult {
  objects: string[];
  rows: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function archiveKey(tenantId: string, sourceId: string, hour: Date, suffix = 0) {
  const d = `${hour.getUTCFullYear()}/${pad(hour.getUTCMonth() + 1)}/${pad(hour.getUTCDate())}`;
  return `raw/${tenantId}/${sourceId}/${d}/${pad(hour.getUTCHours())}${suffix ? `-${suffix}` : ""}.jsonl.gz`;
}

export async function flushRawInbox(pool: Pool, store: ObjectStore, now = new Date()): Promise<FlushResult> {
  const out: FlushResult = { objects: [], rows: 0 };
  const { rows: groups } = await pool.query<{ tenant_id: string; source_id: string; hour: Date }>(
    `select distinct tenant_id, source_id, date_trunc('hour', received_at, 'UTC') as hour
     from raw_inbox where received_at < date_trunc('hour', $1::timestamptz, 'UTC')
     order by hour`,
    [now],
  );

  for (const g of groups) {
    await tx(pool, async (c) => {
      const { rows } = await c.query<{ id: string; received_at: Date; body: unknown }>(
        `select id, received_at, body from raw_inbox
         where source_id = $1 and received_at >= $2 and received_at < $2 + interval '1 hour'
         order by id for update skip locked`,
        [g.source_id, g.hour],
      );
      if (!rows.length) return;
      const lines = rows.map((r) => JSON.stringify({ received_at: r.received_at.toISOString(), body: r.body }));
      const body = gzipSync(lines.join("\n") + "\n");
      let suffix = 0;
      let key = archiveKey(g.tenant_id, g.source_id, g.hour);
      while (!(await store.putNew(key, body, "application/gzip"))) key = archiveKey(g.tenant_id, g.source_id, g.hour, ++suffix);
      await c.query(`delete from raw_inbox where id = any($1::bigint[])`, [rows.map((r) => r.id)]);
      out.objects.push(key);
      out.rows += rows.length;
    });
  }
  return out;
}

export function readArchive(gz: Uint8Array): { received_at: string; body: Record<string, unknown> }[] {
  return gunzipSync(gz).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export async function sweepOrphanDocuments(pool: Pool, store: ObjectStore, now = new Date(), graceMs = 24 * 3600_000) {
  const old = (await store.entries("docs/")).filter((e) => now.getTime() - e.modified.getTime() > graceMs);
  const deleted: string[] = [];
  for (let i = 0; i < old.length; i += 500) {
    const keys = old.slice(i, i + 500).map((e) => e.key);
    const { rows } = await pool.query<{ storage_key: string }>(`select storage_key from documents where storage_key = any($1)`, [keys]);
    const used = new Set(rows.map((r) => r.storage_key));
    for (const key of keys.filter((k) => !used.has(k))) {
      await store.delete(key);
      deleted.push(key);
    }
  }
  return { checked: old.length, deleted };
}
