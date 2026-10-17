import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asUser, freshDb } from "../db/setup";
import { createSource, type Source } from "../../lib/engine/sources";
import { ingestPush } from "../../lib/engine/ingest";
import { applyDerived } from "../../lib/engine/derived";
import { onAlert, type AlertTransition } from "../../lib/engine/hooks";
import type { ModulePackage } from "../../lib/engine/package";
import { testPkg } from "./fixture";

// testPkg plus derived metrics and config acknowledgements ({ack}).
const pkg: ModulePackage = {
  ...testPkg,
  id: "rulemod",
  derived: [
    { key: "spread", fn: "diff", inputs: ["temp", "hum"] },
    { key: "temp_rate", fn: "rate", inputs: ["temp"] },
  ],
  normalize(m) {
    const n = testPkg.normalize(m);
    return Array.isArray(n) ? n : { ...n, configAck: m.ack as number | undefined };
  },
};

let db: Client;
let drop: () => Promise<void>;
let source: Source;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const USER = "00000000-0000-0000-0000-0000000000a1";
const at = (min: number) => new Date(Date.UTC(2026, 9, 17, 10, min));
const msg = (sensor: string, min: number, temp: number, extra: object = {}) =>
  ({ sensor, t: at(min).toISOString(), temp, ...extra });
const push = (msgs: object[], now = at(59)) => ingestPush(db, source, msgs as Record<string, unknown>[], pkg, now);
const objectId = async (ext: string) =>
  (await db.query(`select id from objects where external_id = $1`, [ext])).rows[0].id as string;

async function rule(r: Record<string, unknown>) {
  const row = { module: "rulemod", metric: "temp", op: ">", threshold: 30, severity: "alarm", ...r };
  const cols = Object.keys(row);
  await db.query(
    `insert into rules (tenant_id, ${cols.join(", ")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`,
    [ORG, ...Object.values(row)],
  );
}
const alerts = async (ext: string) => (await db.query(
  `select a.status, a.value, a.peak, a.opened_at, a.resolved_at from object_alerts a
   join objects o on o.id = a.object_id where o.external_id = $1 order by a.id`, [ext],
)).rows;

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into auth.users (id) values ($1)`, [USER]);
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  await db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')`, [ORG, USER]);
  ({ source } = await createSource(db, { tenantId: ORG, name: "gw", module: "rulemod" }));
});
afterAll(async () => drop?.());
beforeEach(async () => {
  await db.query(`delete from rules`);
  await db.query(`delete from object_alerts`);
});

describe("derived metrics", () => {
  it("computes stateless and stateful functions", () => {
    const state = {};
    const defs = pkg.derived!;
    const m1: Record<string, number> = { temp: 20, hum: 50 };
    applyDerived(defs, m1, at(0), state);
    expect(m1).toEqual({ temp: 20, hum: 50, spread: -30 }); // no previous point: no rate yet
    const m2: Record<string, number> = { temp: 26 };
    applyDerived(defs, m2, at(1), state);
    expect(m2).toEqual({ temp: 26, temp_rate: 0.1 }); // spread needs both inputs
    const late: Record<string, number> = { temp: 0 };
    applyDerived(defs, late, at(0), state);
    expect(late.temp_rate).toBeUndefined(); // out of order: ignored, state untouched
    expect(state).toEqual({ temp_rate: { ts: at(1).getTime(), v: 26 } });
  });

  it("stores derived values as metrics and keeps state across batches", async () => {
    await push([msg("d1", 0, 20, { hum: 50 })]);
    const r = await push([msg("d1", 2, 32)]);
    expect(r.metrics).toBe(2); // temp + temp_rate
    const { rows } = await db.query(
      `select k.key, m.value from metrics m join metric_keys k on k.id = m.metric_id
       where m.object_id = $1 and k.key in ('spread', 'temp_rate') order by k.key`, [await objectId("d1")],
    );
    expect(rows).toEqual([{ key: "spread", value: -30 }, { key: "temp_rate", value: 0.1 }]);
  });
});

describe("rules and alerts", () => {
  it("opens after for_s, tracks the peak, resolves with hysteresis", async () => {
    await rule({ key: "hot", for_s: 120, hysteresis: 2 });
    let r = await push([msg("s1", 0, 31), msg("s1", 1, 33)]);
    expect(r.alerts.opened).toBe(0); // breaching for 60 s only
    r = await push([msg("s1", 2, 35), msg("s1", 3, 34)]);
    expect(r.alerts.opened).toBe(1);
    r = await push([msg("s1", 4, 29)]); // within the 2° band: still active
    expect(r.alerts.resolved).toBe(0);
    r = await push([msg("s1", 5, 27.5)]);
    expect(r.alerts.resolved).toBe(1);
    expect(await alerts("s1")).toEqual([{
      status: "resolved", value: 35, peak: 35, opened_at: at(2), resolved_at: at(5),
    }]);
    const { rows: ev } = await db.query(
      `select type, severity from events where type like 'alert.%' and ts >= $1 order by id`, [at(0)],
    );
    expect(ev.slice(-2)).toEqual([{ type: "alert.opened", severity: "alarm" }, { type: "alert.resolved", severity: "info" }]);
  });

  it("a dip below threshold resets the for_s timer; late points are ignored", async () => {
    await rule({ key: "hot", for_s: 120 });
    await push([msg("s2", 0, 31), msg("s2", 1, 29), msg("s2", 2, 31), msg("s2", 3, 31)]);
    expect(await alerts("s2")).toHaveLength(0);
    await push([msg("s2", 1, 99)]); // older than the last evaluated point
    expect(await alerts("s2")).toHaveLength(0);
    await push([msg("s2", 4, 31)]);
    expect(await alerts("s2")).toHaveLength(1);
  });

  it("per-object override wins over the type-wide rule of the same family", async () => {
    await push([msg("a", 10, 20), msg("b", 10, 20)]);
    await rule({ key: "hot", object_type: "sensor", threshold: 30 });
    await rule({ key: "hot", object_id: await objectId("b"), threshold: 40 });
    await push([msg("a", 11, 35), msg("b", 11, 35)]);
    expect(await alerts("a")).toHaveLength(1);
    expect(await alerts("b")).toHaveLength(0);
    await push([msg("b", 12, 41)]);
    expect(await alerts("b")).toHaveLength(1);
  });

  it("one active alert per rule and object; acknowledged alerts still resolve", async () => {
    await rule({ key: "hot" });
    await push([msg("c", 20, 35)]);
    await push([msg("c", 21, 36)]);
    const { rows: [a] } = await db.query(`select id from object_alerts`);
    await asUser(db, USER, async () => {
      expect((await db.query(`select ack_alert($1) ok`, [a.id])).rows[0].ok).toBe(true);
      expect((await db.query(`select ack_alert($1) ok`, [a.id])).rows[0].ok).toBe(false);
      await expect(db.query(`update object_alerts set status = 'resolved'`)).resolves.toMatchObject({ rowCount: 0 });
      expect((await db.query(`select status, acked_by from object_alerts`)).rows).toEqual([{ status: "acknowledged", acked_by: USER }]);
    }); // rolled back: the session ends
    await db.query(`update object_alerts set status = 'acknowledged'`);
    await push([msg("c", 22, 20)]);
    expect((await alerts("c")).map((x) => x.status)).toEqual(["resolved"]);
  });

  it("calls alert hooks and survives a failing one", async () => {
    await rule({ key: "hot" });
    const seen: AlertTransition[] = [];
    const offA = onAlert(() => { throw new Error("boom"); });
    const offB = onAlert((t) => void seen.push(t));
    const orig = console.error;
    console.error = () => {};
    try {
      await push([msg("h", 30, 50)]);
    } finally {
      console.error = orig; offA(); offB();
    }
    expect(seen).toMatchObject([{ kind: "opened", ruleKey: "hot", value: 50, severity: "alarm" }]);
  });

  it("tenants only see their own rules and alerts", async () => {
    await rule({ key: "hot" });
    await db.query(
      `insert into rules (tenant_id, key, module, metric, op, threshold, severity) values ($1, 'x', 'rulemod', 'temp', '>', 1, 'info')`,
      [OTHER],
    );
    await asUser(db, USER, async () => {
      expect((await db.query(`select tenant_id from rules`)).rows).toEqual([{ tenant_id: ORG }]);
      await expect(db.query(
        `insert into rules (tenant_id, key, module, metric, op, threshold, severity) values ($1, 'y', 'rulemod', 'temp', '>', 1, 'info')`,
        [ORG],
      )).rejects.toThrow(/row-level security/); // viewers cannot manage rules
    });
  });
});

describe("device config", () => {
  it("returns pushed thresholds until the device acknowledges the version", async () => {
    await push([msg("p", 40, 20)]);
    await rule({ key: "hot", push_to_device: true, threshold: 30, hysteresis: 1 });
    await rule({ key: "cold", op: "<", threshold: 5 }); // not pushed
    let r = await push([msg("p", 41, 20)]);
    expect(r.configs).toEqual([{
      type: "sensor", externalId: "p", version: expect.any(Number),
      thresholds: { hot: { metric: "temp", op: ">", threshold: 30, hysteresis: 1, for_s: 0 } },
    }]);
    const v1 = r.configs[0].version;
    r = await push([msg("p", 42, 20, { ack: v1 })]);
    expect(r.configs).toEqual([]);

    await rule({ key: "hot", object_id: await objectId("p"), push_to_device: true, threshold: 28 });
    r = await push([msg("p", 43, 20, { ack: v1 })]);
    expect(r.configs[0].thresholds.hot.threshold).toBe(28);
    expect(r.configs[0].version).not.toBe(v1);
  });
});
