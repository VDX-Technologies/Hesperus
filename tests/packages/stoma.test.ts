import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { hashToken, sourceByToken } from "../../lib/engine/sources";
import { DEFAULTS, legacyDeviceConfig, legacyRuleKey, rulesFromConfig, stomaPackage } from "../../lib/packages/stoma";
import { ingestLegacy } from "../../lib/packages/stoma/legacy";
import { migrateOrg, planOrg } from "../../lib/packages/stoma/migrate";

const at = (min: number) => new Date(Date.UTC(2026, 9, 17, 10, min));
const run = (points: [number, Record<string, number>][]) => {
  const st: Record<string, unknown> = {};
  return points.map(([min, m]) => {
    const metrics: Record<string, number | null | undefined> = { ...m };
    stomaPackage.step!(metrics, at(min), st);
    return metrics;
  });
};

describe("stoma package", () => {
  it("normalizes a payload with an infrared frame", () => {
    const data = Array.from({ length: 64 }, (_, i) => (i < 4 ? 30 : 20));
    const n = stomaPackage.normalize({ node_id: 7, temp_c: 20, rh: 80, ir_w: 8, ir_h: 8, ir: data, cfg_ver: 3 });
    if (Array.isArray(n)) throw new Error("one object expected");
    expect(n.object).toMatchObject({ type: "node", externalId: "7" });
    expect(n.metrics.leaf_c).toBe(20);
    expect(n.metrics.dew_c).toBeCloseTo(16.4, 1);
    expect(n.metrics.hot_area).toBe(6.3);
    expect(n.configAck).toBe(3);
    expect(() => stomaPackage.normalize({ temp_c: 1 })).toThrow(/node_id/);
  });

  it("accumulates humid hours and resets them", () => {
    const hum = { rh: 92, temp_c: 18 };
    const out = run([[0, hum], [30, hum], [60, hum], [90, { rh: 70, temp_c: 18 }]]);
    expect(out.map((m) => m.humid_h)).toEqual([0, 0.5, 1, 0]);
  });

  it("pauses humidity rules during an irrigation boom and ignores late points", () => {
    const st: Record<string, unknown> = {};
    const step = (min: number, rh: number) => {
      const m: Record<string, number | null | undefined> = { rh, cond_margin: 0 };
      stomaPackage.step!(m, at(min), st);
      return m;
    };
    expect(step(0, 60).rh_ctl).toBe(60);
    expect(step(1, 85).rh_ctl).toBeNull();
    expect(step(1 + DEFAULTS.irrigationHoldS / 60 + 1, 85).rh_ctl).toBe(85);
    const before = { ...st };
    step(0, 99);
    expect(st).toEqual(before);
  });

  it("turns thresholds into rule families and back", () => {
    const rules = rulesFromConfig({ tMax: 30, tMargin: 2 });
    expect(rules.find((r) => r.key === "temp_high")).toMatchObject({ threshold: 30, op: ">", push_to_device: true });
    expect(rules.find((r) => r.key === "temp_high_warn")!.threshold).toBe(28);
    const thresholds = Object.fromEntries(rules.filter((r) => r.push_to_device).map((r) => [r.key, {
      metric: r.metric, op: r.op, threshold: r.threshold, hysteresis: 0, for_s: 0,
    }]));
    expect(legacyDeviceConfig({ version: 1, thresholds })).toMatchObject({ tMax: 30, tMargin: 2, rhMax: DEFAULTS.rhMax });
    expect([legacyRuleKey("temp_high", "warn"), legacyRuleKey("botrytis", "alarm"), legacyRuleKey("co2_low", "warn")])
      .toEqual(["temp_high_warn", "botrytis", "co2_low"]);
  });
});

describe("migration and /api/ingest adapter", () => {
  let db: Client;
  let drop: () => Promise<void>;
  const ORG = "00000000-0000-0000-0000-00000000000a";
  const DEV = "00000000-0000-0000-0000-0000000000d1";
  const KEY = "gw_secret";

  beforeAll(async () => {
    ({ db, drop } = await freshDb());
    await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a')`, [ORG]);
    await db.query(`insert into org_modules (org_id, module, config) values ($1, 'stoma', '{"tMax": 30}')`, [ORG]);
    await db.query(`insert into gateways (org_id, name, key_hash, key_hint) values ($1, 'GW', $2, 'cret')`, [ORG, hashToken(KEY)]);
    await db.query(
      `insert into devices (id, org_id, module, serial, name, config) values ($1, $2, 'stoma', '7', 'Bench 1', '{"tMax": 35}'),
                                                                        (gen_random_uuid(), $2, 'stoma', '8', 'Bench 2', '{}')`,
      [DEV, ORG],
    );
    await db.query(
      `insert into readings (org_id, device_id, ts, values, meta) values
         ($1, $2, '2025-06-01T10:00Z', '{"temp_c": 20, "rh": 70, "wet_h": null}', '{}'),
         ($1, $2, $3, '{"temp_c": 36, "rh": 91}', '{"humid_h": 2.5, "pm_day": "2026-10-17", "pm_base": 20, "pm_hours": 1}')`,
      [ORG, DEV, at(0)],
    );
    await db.query(
      `insert into alerts (org_id, device_id, ts, level, code, resolved_at) values
         ($1, $2, '2025-06-01T10:00Z', 'warn', 'stoma.rh_high', '2025-06-01T11:00Z'),
         ($1, $2, $3, 'alarm', 'stoma.temp_high', null)`,
      [ORG, DEV, at(0)],
    );
  });
  afterAll(async () => drop?.());

  it("plans without writing", async () => {
    expect(await planOrg(db, ORG)).toEqual({ sources: 1, objects: 2, readings: 2, metrics: 4, rules: 1, alerts: 2 });
    expect((await db.query(`select count(*)::int as n from sources`)).rows[0].n).toBe(0);
  });

  it("moves history, thresholds and alerts, and is idempotent", async () => {
    const first = await migrateOrg(db, ORG);
    expect(first).toMatchObject({ sources: 1, objects: 2, metrics: 4, alerts: 2 });
    const again = await migrateOrg(db, ORG);
    expect(again).toMatchObject({ sources: 0, objects: 0, metrics: 0, alerts: 0 });

    const { rows: parts } = await db.query(
      `select distinct tableoid::regclass::text as p from metrics where ts < '2026-01-01'`,
    );
    expect(parts).toEqual([{ p: "metrics_default" }]);
    const { rows: rules } = await db.query(
      `select key, threshold, object_id is not null as own from rules where key in ('temp_high', 'rh_high') order by key, own`,
    );
    expect(rules).toEqual([
      { key: "rh_high", threshold: DEFAULTS.rhMax, own: false },
      { key: "temp_high", threshold: 30, own: false },
      { key: "temp_high", threshold: 35, own: true },
    ]);
    const { rows: alerts } = await db.query(
      `select r.key, a.status, r.object_id is not null as own from object_alerts a join rules r on r.id = a.rule_id order by a.opened_at`,
    );
    expect(alerts).toEqual([
      { key: "rh_high_warn", status: "resolved", own: false },
      { key: "temp_high", status: "open", own: true },
    ]);
    const { rows: [o] } = await db.query(`select state from objects where external_id = '7'`);
    expect(o.state.pkg).toMatchObject({ ts: at(0).getTime(), rh: 91, humid_h: 2.5, pm_base: 20 });
  });

  it("keeps the gateway key working through the engine", async () => {
    const source = (await sourceByToken(db, KEY))!;
    expect(source.module).toBe("stoma");
    const [r] = await ingestLegacy(db, source, [{ node_id: 7, temp_c: 20, rh: 91, cfg_ver: 1 }], at(30));
    // the device keeps its own threshold; back under 35 °C the migrated alarm resolves
    expect(r).toMatchObject({ serial: "7", status: "alarm", config: { tMax: 35, irrigationHoldS: DEFAULTS.irrigationHoldS } });
    const { rows: open } = await db.query(
      `select r.key from object_alerts a join rules r on r.id = a.rule_id where a.status <> 'resolved' order by r.key`,
    );
    expect(open.map((x) => x.key)).toEqual(["rh_high", "rh_high_warn"]);
    expect(r).toMatchObject({ alerts: 2 });
    const { rows: [m] } = await db.query(
      `select m.value from metrics m join metric_keys k on k.id = m.metric_id where k.key = 'humid_h' and m.ts = $1`, [at(30)],
    );
    expect(m.value).toBe(3); // 2.5 h carried over from the legacy reading + 0.5 h
    expect(await ingestLegacy(db, source, [{ temp_c: 1 }, { module: "tag", node_id: 1 }])).toEqual([
      { error: "node_id is required", status: 400 },
      { error: "unknown module tag", status: 400 },
    ]);
  });
});
