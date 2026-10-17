// Raw inbox -> object storage. Closed hours are written as one gzipped JSONL object per
// source and hour: raw/{tenant}/{source}/{yyyy}/{mm}/{dd}/{hh}.jsonl.gz. Objects are never
// overwritten; a late batch for an already flushed hour gets a suffix (hh-1, hh-2, ...).
// Rows leave the inbox only after their object is stored.
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
      if (!rows.length) return; // another flusher has it
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
