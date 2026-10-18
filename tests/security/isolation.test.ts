// Two tenants on one pool: the TenantDb guard refuses unscoped queries, and every console,
// series and rules read for org A returns nothing of org B.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { forTenant, TenantScopeError } from "../../lib/engine/db";
import { createSource } from "../../lib/engine/sources";
import { ingestPush, registerPackage } from "../../lib/engine/ingest";
import { series } from "../../lib/engine/query";
import { loadRules, upsertRules } from "../../lib/engine/rules";
import { testPkg } from "../engine/fixture";

vi.mock("server-only", () => ({}));
const { listObjects, listAlerts, countOpenAlerts } = await import("../../lib/packages/console");

let db: Client;
let drop: () => Promise<void>;
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const NOW = new Date();
let objB: string;

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [A, B]);
  await registerPackage(db, testPkg);
  for (const org of [A, B]) {
    const { source } = await createSource(db, { tenantId: org, name: "gw", module: "testmod" });
    await upsertRules(forTenant(db, org), "testmod", [{ key: "hot", metric: "temp", op: ">", threshold: 30, severity: "alarm" }]);
    await ingestPush(db, source, [{ sensor: `s-${org}`, temp: 40, alarm: true }], testPkg, NOW);
  }
  objB = (await db.query(`select id from objects where tenant_id = $1`, [B])).rows[0].id;
});
afterAll(async () => drop?.());

describe("TenantDb guard", () => {
  it("refuses queries that do not name tenant_id", async () => {
    await expect(forTenant(db, A).query(`select * from objects`)).rejects.toThrow(TenantScopeError);
  });
  it("refuses a tenant other than the bound one as $1", async () => {
    await expect(forTenant(db, A).query(`select * from objects where tenant_id = $1`, [B])).rejects.toThrow(TenantScopeError);
    await expect(forTenant(db, A).query(`select * from objects where tenant_id = $1`)).rejects.toThrow(TenantScopeError);
  });
  it("requires a tenant id", () => {
    expect(() => forTenant(db, "")).toThrow(TenantScopeError);
  });
});

describe("org A sees nothing of org B", () => {
  it("objects", async () => {
    const objs = await listObjects(forTenant(db, A), "testmod");
    expect(objs.map((o) => o.externalId)).toEqual([`s-${A}`]);
    expect(await listObjects(forTenant(db, A), "testmod", objB)).toEqual([]);
  });
  it("alerts", async () => {
    const alerts = await listAlerts(forTenant(db, A), "en");
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((a) => a.objectId !== objB)).toBe(true);
    expect(await listAlerts(forTenant(db, A), "en", { objectId: objB })).toEqual([]);
    expect(await countOpenAlerts(forTenant(db, B))).toBeGreaterThan(0);
  });
  it("series", async () => {
    const q = { objectId: objB, module: "testmod", metrics: ["temp"], from: new Date(NOW.getTime() - 3600000), to: new Date(NOW.getTime() + 1000), level: "raw" as const };
    expect((await series(forTenant(db, A), q)).series.temp).toEqual([]);
    expect((await series(forTenant(db, B), q)).series.temp).toHaveLength(1);
  });
  it("rules", async () => {
    const rules = await loadRules(forTenant(db, A), "testmod");
    expect(rules).toHaveLength(1);
    expect(rules.every((r) => (r as { tenant_id?: string }).tenant_id !== B)).toBe(true);
  });
});
