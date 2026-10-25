import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { createSource, markSeen, sourceByToken, sourceErrors, type Source } from "../../lib/engine/sources";
import { forTenant } from "../../lib/engine/db";
import type { ModulePackage } from "../../lib/engine/package";
import { ingestPush } from "../../lib/engine/ingest";
import { pushConnector } from "../../lib/engine/connectors";
import { testPkg } from "./fixture";

let db: Client;
let drop: () => Promise<void>;
let source: Source;
let token: string;
const ORG = "00000000-0000-0000-0000-00000000000a";
const NOW = new Date("2026-10-17T10:30:00Z");

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a')`, [ORG]);
  ({ source, token } = await createSource(db, { tenantId: ORG, name: "gw", module: "testmod" }));
});
afterAll(async () => drop?.());

const count = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0].n as number;

describe("sources", () => {
  it("stores only the token hash and finds the source by token", async () => {
    expect(token).toMatch(/^vdx_/);
    const { rows } = await db.query(`select token_hash, token_hint from sources where id = $1`, [source.id]);
    expect(rows[0].token_hash).not.toContain(token);
    expect(rows[0].token_hint).toBe(token.slice(-4));
    expect((await sourceByToken(db, token))?.id).toBe(source.id);
    expect(await sourceByToken(db, token + "x")).toBeNull();
  });

  it("push connector accepts an object or an array of objects", () => {
    expect(pushConnector.messages(source, { a: 1 })).toEqual([{ a: 1 }]);
    expect(() => pushConnector.messages(source, [1])).toThrow(/JSON object/);
  });
});

describe("ingestPush", () => {
  it("archives everything, ingests valid messages, reports invalid ones", async () => {
    const r = await ingestPush(db, source, [
      { sensor: "s1", model: "x", t: "2026-10-17T10:29:00Z", temp: 21.5, hum: 40 },
      { nope: true },
      { sensor: "s1", t: "2026-10-17T10:30:00Z", temp: Number.NaN, hum: 41, alarm: true },
    ], testPkg, NOW);
    expect(r.accepted).toBe(2);
    expect(r.rejected).toEqual([{ index: 1, error: "sensor is required" }]);
    expect(r.metrics).toBe(3); // NaN and undeclared "other" skipped
    expect(r.events).toBe(1);
    expect(await count(`select count(*)::int n from raw_inbox`)).toBe(3);

    const { rows: objs } = await db.query(`select id, properties, last_seen from objects`);
    expect(objs).toHaveLength(1);
    expect(objs[0].properties).toEqual({ model: "x" });
    expect(objs[0].last_seen).toEqual(new Date("2026-10-17T10:30:00Z"));
    const { rows: ev } = await db.query(
      `select e.type, e.severity, eo.object_id from events e join event_objects eo on eo.event_id = e.id`,
    );
    expect(ev).toEqual([{ type: "testmod.overheat", severity: "alarm", object_id: objs[0].id }]);
    const { rows: src } = await db.query(`select last_seen, last_error from sources where id = $1`, [source.id]);
    expect(src[0].last_seen).toEqual(NOW);
    expect(src[0].last_error).toMatch(/1 rejected/);
  });

  it("is idempotent on metrics and uses the receive time when ts is missing", async () => {
    const msg = { sensor: "s1", t: "2026-10-17T10:29:00Z", temp: 99 };
    const r = await ingestPush(db, source, [msg, { sensor: "s2", temp: 5 }], testPkg, NOW);
    expect(r.metrics).toBe(1); // s1 duplicate ignored
    const { rows } = await db.query(
      `select m.ts from metrics m join objects o on o.id = m.object_id where o.external_id = 's2'`,
    );
    expect(rows[0].ts).toEqual(NOW);
  });

  it("rejects timestamps too far in the future and oversized batches", async () => {
    const r = await ingestPush(db, source, [{ sensor: "s1", t: "2026-10-17T11:00:00Z", temp: 1 }], testPkg, NOW);
    expect(r.rejected[0].error).toMatch(/future/);
    const big = Array.from({ length: 501 }, () => ({ sensor: "s1" }));
    await expect(ingestPush(db, source, big, testPkg, NOW)).rejects.toThrow(/batch too large/);
  });

  it("registers package types and metrics globally, once", async () => {
    expect(await count(`select count(*)::int n from object_types where module = 'testmod' and tenant_id is null`)).toBe(1);
    expect(await count(`select count(*)::int n from metric_keys where module = 'testmod'`)).toBe(2);
  });
});

describe("ingest ordering and limits on what a message writes", () => {
  const props = (id: string) => db.query(`select properties, last_seen from objects where external_id = $1`, [id]).then((r) => r.rows[0]);

  it("lets the newest message win, wherever it sits in the batch and across batches", async () => {
    await ingestPush(db, source, [
      { sensor: "o1", model: "new", t: "2026-10-17T10:29:00Z" },
      { sensor: "o1", model: "old", t: "2026-10-17T10:20:00Z" },
    ], testPkg, NOW);
    expect(await props("o1")).toEqual({ properties: { model: "new" }, last_seen: new Date("2026-10-17T10:29:00Z") });
    // a late batch with older data does not overwrite newer values or move last_seen back
    await ingestPush(db, source, [{ sensor: "o1", model: "older", t: "2026-10-17T10:10:00Z" }], testPkg, NOW);
    expect(await props("o1")).toEqual({ properties: { model: "new" }, last_seen: new Date("2026-10-17T10:29:00Z") });
  });

  it("ignores a config sent by a device", async () => {
    const pkg: ModulePackage = {
      ...testPkg,
      normalize: (m) => ({ ...testPkg.normalize(m), object: { type: "sensor", externalId: m.sensor as string, properties: m.props as Record<string, unknown> } }),
    };
    await ingestPush(db, source, [{ sensor: "c1", props: { model: "y", config: { temp: { max: 1 } } } }], pkg, NOW);
    expect((await props("c1")).properties).toEqual({ model: "y" });
  });

  it("counts undeclared metrics and shows them as the source's error", async () => {
    const r = await ingestPush(db, source, [{ sensor: "u1", temp: 1 }, { sensor: "u2", temp: 2 }], testPkg, NOW);
    expect(r.undeclared).toEqual({ other: 2 });
    const { rows } = await db.query(`select last_error from sources where id = $1`, [source.id]);
    expect(rows[0].last_error).toBe("undeclared metrics ignored: other");
  });

  it("keeps the newest 50 errors per source", async () => {
    const { source: s } = await createSource(db, { tenantId: ORG, name: "noisy", module: "testmod" });
    for (let i = 0; i < 55; i++) await markSeen(db, s, `error ${i}`, new Date(NOW.getTime() + i * 1000));
    expect(await count(`select count(*)::int n from source_errors where source_id = $1`, [s.id])).toBe(50);
    const recent = await sourceErrors(forTenant(db, ORG), s.id, 3);
    expect(recent.map((e) => e.error)).toEqual(["error 54", "error 53", "error 52"]);
    await markSeen(db, s, null, NOW);
    expect(await count(`select count(*)::int n from source_errors where source_id = $1`, [s.id])).toBe(50);
  });
});
