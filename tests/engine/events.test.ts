// Typed events and the manual connector: one schema checked the same way in the app and in
// the database whatever the origin, corrections as new versions, and the generic reads.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import { createSource } from "../../lib/engine/sources";
import { ingestPush, registerPackage } from "../../lib/engine/ingest";
import { createPlace, setObjectPlace } from "../../lib/engine/places";
import { ValidationError, type ModulePackage } from "../../lib/engine/package";
import { parseDecimal, payloadFromForm, validateProperties, type Schema } from "../../lib/engine/schema";
import { correctManualEvent, createManualEvent, ManualEventError, voidEvent, type Author } from "../../lib/engine/manual";
import { eventHistory, getEvent, lastEventBy, listEvents } from "../../lib/engine/events";
import { listAudit } from "../../lib/engine/audit";

const pkg: ModulePackage = {
  id: "evmod",
  objectTypes: [{ key: "thing", name: { en: "Thing" }, properties: {} }],
  eventTypes: [
    {
      key: "dose",
      name: { en: "Dose" },
      fields: {
        product: { type: "string", required: true },
        amount: { type: "quantity", required: true, units: ["kg", "L"], min: 0 },
        note: { type: "string" },
      },
    },
  ],
  metrics: [],
  normalize(m) {
    if (typeof m.thing !== "string") throw new ValidationError("thing is required");
    return { object: { type: "thing", externalId: m.thing }, metrics: {}, events: m.dose ? [{ type: "dose", severity: "info", payload: m.dose as Record<string, unknown> }] : [] };
  },
};

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const owner: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "o@x.it", role: "owner" };
const member: Author = { id: "00000000-0000-0000-0000-0000000000f2", email: "m@x.it", role: "member" };
const viewer: Author = { id: "00000000-0000-0000-0000-0000000000f3", email: "v@x.it", role: "viewer" };
const things: string[] = [];
let otherThing: string;
let site: string, area: string;
const dose = (value: number, product = "Rame") => ({ product, amount: { value, unit: "kg" } });

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  await registerPackage(db, pkg);
  const { source } = await createSource(db, { tenantId: ORG, name: "gw", module: "evmod" });
  await ingestPush(db, source, [{ thing: "t1" }, { thing: "t2" }], pkg, new Date());
  things.push(...(await db.query(`select id from objects where tenant_id = $1 order by external_id`, [ORG])).rows.map((r) => r.id));
  const { source: s2 } = await createSource(db, { tenantId: OTHER, name: "gw", module: "evmod" });
  await ingestPush(db, s2, [{ thing: "x" }], pkg, new Date());
  otherThing = (await db.query(`select id from objects where tenant_id = $1`, [OTHER])).rows[0].id;
  A = forTenant(db, ORG);
  site = await createPlace(A, { kind: "site", name: "Farm" });
  area = await createPlace(A, { kind: "area", name: "North", parentId: site });
  await setObjectPlace(A, things[0], area);
});
afterAll(async () => drop?.());

describe("schema", () => {
  const schema: Schema = {
    s: { type: "string", enum: ["a", "b"] },
    i: { type: "integer", min: 1, max: 5 },
    n: { type: "number" },
    b: { type: "boolean" },
    t: { type: "timestamp" },
    q: { type: "quantity", units: ["kg", "L"], min: 0 },
    r: { type: "string", required: true },
  };
  const cases: unknown[] = [
    { r: "x" },
    { r: "x", s: "a", i: 3, n: 1.5, b: true, t: "2026-10-18T10:00:00Z", q: { value: 2, unit: "L" } },
    {},
    { r: 1 },
    { r: "x", zz: 1 },
    { r: "x", s: "c" },
    { r: "x", i: 2.5 },
    { r: "x", i: 9 },
    { r: "x", t: "nope" },
    { r: "x", q: 3 },
    { r: "x", q: { value: 1 } },
    { r: "x", q: { value: 1, unit: "g" } },
    { r: "x", q: { value: -1, unit: "kg" } },
    { r: "x", q: { value: 1, unit: "kg", extra: 1 } },
    [],
  ];

  it("gives the same answer as the database", async () => {
    for (const c of cases) {
      const { rows } = await db.query(`select validate_properties($1, $2) err`, [JSON.stringify(schema), JSON.stringify(c)]);
      expect(validateProperties(schema, c), JSON.stringify(c)).toBe(rows[0].err);
    }
  });

  it("reads comma decimals, units and dates from the form", () => {
    expect(parseDecimal("1,5")).toBe(1.5);
    expect(parseDecimal("1.234,5")).toBe(1234.5);
    expect(parseDecimal("abc")).toBeNull();
    const { payload, errors } = payloadFromForm(schema, { r: " x ", q: "2,5", "q.unit": "L", t: "2026-10-18", i: "", n: "x" });
    expect(payload).toEqual({ r: "x", q: { value: 2.5, unit: "L" }, t: "2026-10-18T12:00:00.000Z" });
    expect(errors).toEqual({ n: "notNumber" });
    expect(payloadFromForm(schema, { q: "1" }).errors).toEqual({ q: "unitRequired" });
  });
});

describe("validation on every path", () => {
  it("rejects a pushed event whose payload breaks the type's schema", async () => {
    const { source } = await createSource(db, { tenantId: ORG, name: "gw2", module: "evmod" });
    await expect(ingestPush(db, source, [{ thing: "t1", dose: { product: "Rame" } }], pkg, new Date())).rejects.toThrow(/amount" is required/);
    const r = await ingestPush(db, source, [{ thing: "t1", dose: dose(1) }], pkg, new Date());
    expect(r.events).toBe(1);
  });

  it("leaves undeclared event types free", async () => {
    await db.query(`insert into events (tenant_id, type, severity, payload) values ($1, 'evmod.other', 'info', '{"any": 1}')`, [ORG]);
  });
});

describe("manual events", () => {
  it("records author, recorded_at and event time, linked to several objects, with raw copy and audit", async () => {
    const now = new Date("2026-10-18T09:00:00Z");
    const ts = new Date("2026-10-17T12:00:00Z");
    const id = await createManualEvent(A, pkg, member, { type: "dose", ts, payload: dose(2.5), objectIds: things }, now);
    const e = (await getEvent(A, id))!;
    expect(e).toMatchObject({ type: "evmod.dose", author: member.id, authorLabel: "m@x.it", ts, recordedAt: now, version: 1, rootId: id });
    expect([...e.objectIds].sort()).toEqual([...things].sort());
    const src = await db.query(`select connector from sources where id = $1`, [e.sourceId]);
    expect(src.rows[0].connector).toBe("manual");
    const raw = await db.query(`select count(*)::int n from raw_inbox where source_id = $1`, [e.sourceId]);
    expect(raw.rows[0].n).toBe(1);
    const [a] = await listAudit(A, { objectId: things[0] });
    expect(a).toMatchObject({ action: "event.create", actor: member.id, subject: "evmod.dose" });
  });

  it("refuses viewers, bad payloads, unknown types and objects of another tenant", async () => {
    const ts = new Date();
    const go = (author: Author, input: Partial<Parameters<typeof createManualEvent>[3]>) =>
      createManualEvent(A, pkg, author, { type: "dose", ts, payload: dose(1), objectIds: [things[0]], ...input });
    await expect(go(viewer, {})).rejects.toMatchObject({ status: 403 });
    await expect(go(owner, { payload: { product: "Rame", amount: { value: 1, unit: "g" } } })).rejects.toMatchObject({ status: 400 });
    await expect(go(owner, { type: "nope" })).rejects.toMatchObject({ status: 400 });
    await expect(go(owner, { objectIds: [otherThing] })).rejects.toMatchObject({ status: 404 });
    await expect(go(owner, { objectIds: [] })).rejects.toBeInstanceOf(ManualEventError);
  });

  it("corrects with a new version; the old one stays readable and cannot be changed", async () => {
    const ts = new Date("2026-10-10T12:00:00Z");
    const v1 = await createManualEvent(A, pkg, owner, { type: "dose", ts, payload: dose(3, "Zolfo"), objectIds: [things[1]] });
    const v2 = await correctManualEvent(A, pkg, member, v1, { ts, payload: dose(4, "Zolfo") });
    const v3 = await correctManualEvent(A, pkg, owner, v2, { ts, payload: { ...dose(4, "Zolfo"), note: "ok" } });
    await expect(correctManualEvent(A, pkg, owner, v1, { ts, payload: dose(5) })).rejects.toMatchObject({ status: 409 });
    await expect(correctManualEvent(A, pkg, viewer, v3, { ts, payload: dose(5) })).rejects.toMatchObject({ status: 403 });

    const history = await eventHistory(A, v2);
    expect(history.map((h) => [h.id, h.version, h.supersedes, h.rootId])).toEqual([[v1, 1, null, v1], [v2, 2, v1, v1], [v3, 3, v2, v1]]);
    expect(history[2].objectIds).toEqual([things[1]]);

    const current = await listEvents(A, { objectId: things[1], types: ["evmod.dose"] });
    expect(current.filter((e) => e.payload.product === "Zolfo").map((e) => e.id)).toEqual([v3]);
    expect((await listEvents(A, { objectId: things[1], current: false, payload: { product: "Zolfo" } })).length).toBe(3);

    await expect(db.query(`update events set payload = '{}' where id = $1`, [v1])).rejects.toThrow(/cannot be changed/);
    await expect(db.query(`delete from events where id = $1`, [v1])).rejects.toThrow(/cannot be changed/);
    const audit = await listAudit(A, { objectId: things[1] });
    expect(audit.filter((a) => a.action === "event.correct").length).toBe(2);
  });

  it("voids with a reason: out of the current events, kept in the history and the audit", async () => {
    const ts = new Date("2026-10-11T12:00:00Z");
    const v1 = await createManualEvent(A, pkg, owner, { type: "dose", ts, payload: dose(2, "Annullato"), objectIds: [things[1]] });
    await expect(voidEvent(A, viewer, v1, "errore")).rejects.toMatchObject({ status: 403 });
    await expect(voidEvent(A, member, v1, "  ")).rejects.toMatchObject({ status: 400 });
    const v2 = await voidEvent(A, member, v1, "inserita due volte");
    await expect(voidEvent(A, owner, v2, "ancora")).rejects.toMatchObject({ status: 409 });
    await expect(correctManualEvent(A, pkg, owner, v2, { ts, payload: dose(3) })).rejects.toMatchObject({ status: 409 });

    expect((await listEvents(A, { payload: { product: "Annullato" } })).length).toBe(0);
    const voided = await listEvents(A, { voided: true, types: ["evmod.dose"] });
    expect(voided.map((e) => [e.id, e.voided, e.payload.product])).toEqual([[v2, "inserita due volte", "Annullato"]]);
    expect((await eventHistory(A, v1)).map((h) => h.voided)).toEqual([null, "inserita due volte"]);
    expect((await listAudit(A, { objectId: things[1] })).some((a) => a.action === "event.void")).toBe(true);
  });

  it("reads by place (recursively), period and author; lastEventBy", async () => {
    const day = (d: number) => new Date(Date.UTC(2026, 8, d, 12));
    const a = await createManualEvent(A, pkg, owner, { type: "dose", ts: day(1), payload: dose(1, "P1"), objectIds: [things[0]] });
    await createManualEvent(A, pkg, owner, { type: "dose", ts: day(5), payload: dose(1, "P2"), objectIds: [things[1]] });
    const atSite = await listEvents(A, { objectId: site, from: day(1), to: day(30) });
    expect(atSite.map((e) => e.id)).toEqual([a]);
    expect(await listEvents(A, { objectId: site, recursive: false })).toEqual([]);
    expect((await listEvents(A, { from: day(1), to: day(30) })).length).toBe(2);
    expect((await listEvents(A, { author: owner.id, payload: { product: "P1" } })).map((e) => e.id)).toEqual([a]);

    const last = await lastEventBy(A, owner.id, "evmod.dose");
    expect(last?.payload.product).toBe("P2");
    expect(await lastEventBy(A, viewer.id, "evmod.dose")).toBeNull();
  });

  it("stops at the daily limit from engine_settings", async () => {
    await db.query(`update engine_settings set value = '0' where key = 'manual.events_per_day'`);
    const { getSettings } = await import("../../lib/engine/settings");
    await getSettings(db, true);
    await expect(createManualEvent(A, pkg, owner, { type: "dose", ts: new Date(), payload: dose(1), objectIds: [things[0]] })).rejects.toMatchObject({ status: 429 });
    await db.query(`update engine_settings set value = '500' where key = 'manual.events_per_day'`);
    await getSettings(db, true);
  });

  it("removes manual events with their organization", async () => {
    const T = "00000000-0000-0000-0000-00000000000c";
    await db.query(`insert into organizations (id, name, slug) values ($1, 'C', 'c')`, [T]);
    const C = forTenant(db, T);
    const o = (await db.query(`insert into objects (tenant_id, type_id) select $1, id from object_types where module = 'evmod' returning id`, [T])).rows[0].id;
    const v1 = await createManualEvent(C, pkg, owner, { type: "dose", ts: new Date(), payload: dose(1), objectIds: [o] });
    await correctManualEvent(C, pkg, owner, v1, { ts: new Date(), payload: dose(2) });
    await db.query(`delete from organizations where id = $1`, [T]);
    expect((await db.query(`select count(*)::int n from events where tenant_id = $1`, [T])).rows[0].n).toBe(0);
  });
});
