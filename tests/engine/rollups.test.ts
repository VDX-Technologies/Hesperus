import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { createSource } from "../../lib/engine/sources";
import { registerPackage } from "../../lib/engine/ingest";
import { pickLevel, series } from "../../lib/engine/query";
import { testPkg } from "./fixture";

let db: Client;
let drop: () => Promise<void>;
let obj: string;
let temp: number;
const ORG = "00000000-0000-0000-0000-00000000000a";
const H = 3_600_000;
// Anchored to the real clock: partitions are created around now().
const BASE = new Date(Math.floor(Date.now() / H) * H - 3 * H); // three hours ago, on the hour
const t = (min: number) => new Date(BASE.getTime() + min * 60_000);

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a')`, [ORG]);
  await createSource(db, { tenantId: ORG, name: "gw", module: "testmod" });
  const reg = await registerPackage(db, testPkg);
  temp = reg.metrics.get("temp")!;
  const { rows } = await db.query(
    `insert into objects (tenant_id, type_id, external_id) values ($1, $2, 's1') returning id`,
    [ORG, reg.types.get("sensor")],
  );
  obj = rows[0].id;
});
afterAll(async () => drop?.());

const put = (ts: Date, value: number) =>
  db.query(`insert into metrics values ($1, $2, $3, $4, $5)`, [ORG, obj, temp, ts, value]);
const rollup = async (now: Date) => (await db.query(`select rollup_metrics($1) r`, [now])).rows[0].r;
const rollups = async (res: number) =>
  (await db.query(`select bucket, min, max, avg, count from metric_rollups where res = $1 order by bucket`, [res])).rows;

describe("rollups", () => {
  it("rolls closed 5 min buckets and closed hours", async () => {
    for (let m = 0; m < 70; m++) await put(t(m), m); // one per minute, 00:00..01:09
    const r = await rollup(t(72)); // 01:10..01:15 bucket still open
    expect(r.rollups_5m).toBe(14);
    const r5 = await rollups(300);
    expect(r5[0]).toMatchObject({ bucket: t(0), min: 0, max: 4, avg: 2, count: 5 });
    const r60 = await rollups(3600);
    expect(r60).toHaveLength(1); // only the first hour is closed
    expect(r60[0]).toMatchObject({ bucket: t(0), min: 0, max: 59, avg: 29.5, count: 60 });
  });

  it("recomputes the lookback window for late data, not older buckets", async () => {
    await put(new Date(t(2).getTime() + 30_000), 100); // late, older than the lookback
    await put(new Date(t(61).getTime() + 30_000), 200); // late, inside the lookback
    await rollup(t(80));
    const r5 = await rollups(300);
    expect(r5.find((r) => +r.bucket === +t(0)).count).toBe(5); // 01:10 - 60 min = 00:10: untouched
    expect(r5.find((r) => +r.bucket === +t(60)).max).toBe(200);
  });

  it("is idempotent and advances the watermark", async () => {
    const before = await rollups(300);
    await rollup(t(80));
    expect(await rollups(300)).toEqual(before);
    const { rows } = await db.query(`select watermark from engine_jobs where name = 'rollup'`);
    expect(rows[0].watermark).toEqual(t(80));
  });

  it("hourly rollups weight 5 min averages by count", async () => {
    for (let m = 70; m < 125; m++) await put(t(m), 1);
    await rollup(t(125));
    const h2 = (await rollups(3600)).find((r) => +r.bucket === +t(60));
    expect(h2.count).toBe(61);
    expect(h2.avg).toBeCloseTo((60 + 61 + 62 + 63 + 64 + 65 + 66 + 67 + 68 + 69 + 200 + 50) / 61);
  });
});

describe("retention", () => {
  const day = 86_400_000;
  it("drops old raw partitions and rollups only after they are covered", async () => {
    const old = new Date(Date.now() - 20 * day);
    const d = old.toISOString().slice(0, 10);
    const name = `metrics_${d.replaceAll("-", "")}`;
    await db.query(`create table ${name} partition of metrics for values from ('${d}T00:00:00Z') to ('${d}T00:00:00Z'::timestamptz + interval '1 day')`);
    await put(old, 1);
    await put(new Date(Date.now() - 400 * day), 1); // default partition
    await db.query(`insert into metric_rollups values ($1, $2, $3, 300, $4, 1, 1, 1, 1), ($1, $2, $3, 3600, $4, 1, 1, 1, 1)`, [
      ORG, obj, temp, new Date(Date.now() - 40 * day),
    ]);

    // Rollups have not reached that far back: nothing raw is dropped.
    await db.query(`update engine_jobs set watermark = $1 where name = 'rollup'`, [new Date(Date.now() - 30 * day)]);
    let r = (await db.query(`select apply_retention() r`)).rows[0].r;
    expect(r).toMatchObject({ partitions_dropped: 0, default_rows: 1, rollups_5m: 1, rollups_1h: 0 });

    await db.query(`update engine_jobs set watermark = $1 where name = 'rollup'`, [t(125)]);
    r = (await db.query(`select apply_retention() r`)).rows[0].r;
    expect(r.partitions_dropped).toBe(1);
    expect((await db.query(`select to_regclass($1) r`, [name])).rows[0].r).toBeNull();
    expect((await rollups(3600)).length).toBeGreaterThan(2); // hourly kept forever
  });

  it("maintenance runs everything and records the outcome", async () => {
    const r = (await db.query(`select engine_maintenance() r`)).rows[0].r;
    expect(r).toHaveProperty("rollup");
    const { rows } = await db.query(`select last_ok, last_error, last_result from engine_jobs where name = 'maintenance'`);
    expect(rows[0].last_error).toBeNull();
    expect(rows[0].last_result).toEqual(r);
    expect((await db.query(`select engine_schedule() s`)).rows[0].s).toBe(false); // no pg_cron here
  });
});

describe("query level", () => {
  it("picks raw, 5m or 1h from the span", async () => {
    const now = new Date();
    const back = (h: number) => new Date(now.getTime() - h * H);
    expect(await pickLevel(db, back(24), now)).toBe("raw");
    expect(await pickLevel(db, back(25), now)).toBe("5m");
    expect(await pickLevel(db, back(24 * 7), now)).toBe("5m");
    expect(await pickLevel(db, back(24 * 8), now)).toBe("1h");
  });

  it("returns series at the chosen level", async () => {
    const q = { objectId: obj, module: "testmod", metrics: ["temp", "hum"], from: t(0), to: t(60) };
    const raw = await series(db, q);
    expect(raw.level).toBe("raw");
    expect(raw.series.temp.length).toBe(61);
    expect(raw.series.hum).toEqual([]);
    const h = await series(db, { ...q, level: "1h" });
    expect(h.series.temp).toEqual([{ ts: t(0), value: 29.5, min: 0, max: 59 }]);
  });
});
