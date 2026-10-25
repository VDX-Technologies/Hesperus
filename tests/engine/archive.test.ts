import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type Client } from "pg";
import { freshDb } from "../db/setup";
import { createSource, type Source } from "../../lib/engine/sources";
import { ingestPush } from "../../lib/engine/ingest";
import { archiveKey, flushRawInbox, readArchive, sweepOrphanDocuments } from "../../lib/engine/archive";
import { replaySource } from "../../lib/engine/replay";
import { MemoryStore } from "../../lib/engine/store";
import { testPkg } from "./fixture";

let db: Client;
let pool: Pool;
let drop: () => Promise<void>;
let source: Source;
const ORG = "00000000-0000-0000-0000-00000000000a";

beforeAll(async () => {
  const f = await freshDb();
  ({ db, drop } = f);
  pool = new Pool({ connectionString: f.url, max: 2 });
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a')`, [ORG]);
  ({ source } = await createSource(db, { tenantId: ORG, name: "gw", module: "testmod" }));
});
afterAll(async () => {
  await pool?.end();
  await drop?.();
});

const at = (s: string) => new Date(`2026-10-17T${s}Z`);
const push = (time: string, ...msgs: Record<string, unknown>[]) => ingestPush(db, source, msgs, testPkg, at(time));
const inbox = async () => (await db.query(`select count(*)::int n from raw_inbox`)).rows[0].n;

describe("raw archive", () => {
  it("builds hourly keys", () => {
    expect(archiveKey("t", "s", at("08:00:00"))).toBe("raw/t/s/2026/10/17/08.jsonl.gz");
    expect(archiveKey("t", "s", at("08:00:00"), 2)).toBe("raw/t/s/2026/10/17/08-2.jsonl.gz");
  });

  it("flushes closed hours only, one gz object per source and hour", async () => {
    const store = new MemoryStore();
    await push("08:10:00", { sensor: "a", temp: 1 }, { bad: 1 });
    await push("08:50:00", { sensor: "a", temp: 2 });
    await push("09:05:00", { sensor: "a", temp: 3 });
    await push("10:01:00", { sensor: "a", temp: 4 }); // current hour stays

    const r = await flushRawInbox(pool, store, at("10:02:00"));
    expect(r.rows).toBe(4);
    expect(await store.list("raw/")).toEqual([
      archiveKey(ORG, source.id, at("08:00:00")),
      archiveKey(ORG, source.id, at("09:00:00")),
    ]);
    expect(await inbox()).toBe(1);
    const lines = readArchive((await store.get(archiveKey(ORG, source.id, at("08:00:00"))))!);
    expect(lines.map((l) => l.body)).toEqual([{ sensor: "a", temp: 1 }, { bad: 1 }, { sensor: "a", temp: 2 }]);
    expect(lines[0].received_at).toBe("2026-10-17T08:10:00.000Z");

    // A late row for an already flushed hour never overwrites it.
    await db.query(`insert into raw_inbox (tenant_id, source_id, received_at, body) values ($1, $2, $3, '{"sensor":"late"}')`, [
      ORG, source.id, at("08:59:00"),
    ]);
    const again = await flushRawInbox(pool, store, at("10:03:00"));
    expect(again.objects).toEqual([archiveKey(ORG, source.id, at("08:00:00"), 1)]);
    expect(await flushRawInbox(pool, store, at("10:04:00"))).toEqual({ objects: [], rows: 0 });
  });

  it("keeps rows in the inbox when the store fails", async () => {
    await push("10:20:00", { sensor: "a", temp: 5 });
    const failing = new MemoryStore();
    failing.putNew = async () => { throw new Error("R2 down"); };
    await expect(flushRawInbox(pool, failing, at("11:00:00"))).rejects.toThrow("R2 down");
    expect(await inbox()).toBe(2);
  });

  it("replays the archive idempotently", async () => {
    const store = new MemoryStore();
    await flushRawInbox(pool, store, at("11:00:00"));
    await db.query(`delete from metrics`);
    await db.query(`delete from events`);

    const dry = await replaySource(db, store, source, testPkg, { dryRun: true });
    expect(dry.total.accepted).toBe(2);
    expect((await db.query(`select count(*)::int n from metrics`)).rows[0].n).toBe(0);

    const r = await replaySource(db, store, source, testPkg);
    expect(r.total.metrics).toBe(2);
    expect((await replaySource(db, store, source, testPkg)).total.metrics).toBe(0);
    expect(await inbox()).toBe(0); // replay does not re-archive
    expect((await db.query(`select count(*)::int n from events`)).rows[0].n).toBe(0);
  });
});

describe("orphan sweep", () => {
  it("deletes old document bytes no document points at, and nothing else", async () => {
    const store = new MemoryStore();
    const now = new Date("2026-10-20T12:00:00Z");
    const old = new Date("2026-10-18T12:00:00Z");
    const key = (n: string) => `docs/${ORG}/${source.id}/${n}`;
    for (const [k, at] of [[key("kept"), old], [key("orphan"), old], [key("young"), now], ["raw/x.jsonl.gz", old]] as const) {
      await store.putNew(k, new Uint8Array([1]));
      store.modified.set(k, at);
    }
    await db.query(
      `insert into documents (tenant_id, storage_key, filename, content_type, size, sha256, metadata, source_id) values ($1, $2, 'k', 'text/plain', 1, 'aa', '{}', $3)`,
      [ORG, key("kept"), source.id],
    );
    const out = await sweepOrphanDocuments(pool, store, now);
    expect(out).toEqual({ checked: 2, deleted: [key("orphan")] });
    expect([...store.objects.keys()].sort()).toEqual(["raw/x.jsonl.gz", key("kept"), key("young")].sort());
  });
});
