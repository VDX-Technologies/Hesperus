import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
vi.mock("server-only", () => ({}));
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import type { Author } from "../../lib/engine/manual";
import { createSource, type Source } from "../../lib/engine/sources";
import { MemoryStore } from "../../lib/engine/store";
import { createObject, getObject, listObjects, objectByExternalId, updateObject } from "../../lib/engine/custom-objects";
import { csvMessages, ingestCustom, pushDocument } from "../../lib/engine/custom-ingest";
import { getSettings } from "../../lib/engine/settings";
import { seedResearch } from "../../scripts/research/types";

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb, B: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const owner: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "o@x.it", role: "owner" };
let tess: string, other: string, sector: string;
let src: Source, otherSrc: Source;

const run = (key = "run-1") => ({
  kind: "event", type: "custom.run", key, ts: "2026-10-20T10:00:00Z",
  payload: { commit: "abc123", items: 2, outcome: "ok" }, objects: [tess, { type: "custom.dataset", externalId: "S70" }],
});
const result = (id: string, score: number, extra: Record<string, unknown> = { tic_id: Number(id) }) => ({
  kind: "object", type: "custom.result", externalId: `tic-${id}`, name: `TIC ${id}`,
  properties: { score, extra }, defaults: { review: "to_review" },
});

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  A = forTenant(db, ORG);
  B = forTenant(db, OTHER);
  await seedResearch(A, owner);
  await seedResearch(B, { ...owner, id: "00000000-0000-0000-0000-0000000000f3" });
  const project = (name: string) => createObject(A, owner, {
    type: "custom.project", name, properties: { area: "astrofisica", stage: "running", result_schema: { tic_id: { type: "integer", required: true } } },
  });
  tess = await project("TESS anomalie");
  other = await project("Altro progetto");
  sector = await createObject(A, owner, { type: "custom.dataset", name: "TESS S70", externalId: "S70", properties: { source: "MAST" } });
  ({ source: src } = await createSource(db, {
    tenantId: ORG, name: "tess-pipeline", module: "custom", config: { scope: { link: "project", id: tess, also: ["custom.dataset"] } },
  }));
  ({ source: otherSrc } = await createSource(db, { tenantId: OTHER, name: "b-pipeline", module: "custom" }));
});
afterAll(async () => drop?.());

describe("custom push", () => {
  it("stores a run once and its results once, however often they are sent", async () => {
    const first = await ingestCustom(db, src, [run(), result("1", 0.9), result("2", 0.4)]);
    expect(first.rejected).toEqual([]);
    expect(first.results.map((r) => r.status)).toEqual(["created", "created", "created"]);
    const again = await ingestCustom(db, src, [run(), result("1", 0.9), result("2", 0.4)]);
    expect(again.results.map((r) => r.status)).toEqual(["duplicate", "unchanged", "unchanged"]);
    expect(again.results[0].id).toBe(first.results[0].id);

    const { rows } = await db.query(`select count(*)::int n from events where tenant_id = $1 and type = 'custom.run'`, [ORG]);
    expect(rows[0].n).toBe(1);
    const results = await listObjects(A, "custom.result", { linkedTo: { key: "project", id: tess } });
    expect(results.map((o) => o.name).sort()).toEqual(["TIC 1", "TIC 2"]);
    const objs = await db.query(`select object_id from event_objects where event_id = $1`, [first.results[0].id]);
    expect(objs.rows.map((r) => r.object_id).sort()).toEqual([tess, sector].sort());
    const audit = await db.query(`select action, actor, actor_label from audit_log where tenant_id = $1 and actor_label = 'source:tess-pipeline' order by id`, [ORG]);
    expect(audit.rows.map((r) => r.action)).toEqual(["event.create", "object.create", "object.create"]);
    expect(audit.rows[0].actor).toBeNull();
  });

  it("a new run updates the score and keeps the review made in Core", async () => {
    const r1 = (await objectByExternalId(A, "custom.result", "tic-1"))!;
    await updateObject(A, owner, r1.id, { properties: { ...r1.properties, review: "interesting", note: "da guardare" } });
    const next = await ingestCustom(db, src, [run("run-2"), { ...result("1", 0.95), properties: { score: 0.95, run: 2, extra: { tic_id: 1 } } }]);
    expect(next.results.map((r) => r.status)).toEqual(["created", "updated"]);
    const after = (await getObject(A, r1.id))!;
    expect(after.properties).toMatchObject({ score: 0.95, review: "interesting", note: "da guardare", run: 2 });
    const audit = await db.query(`select data from audit_log where object_id = $1 and action = 'object.update' order by id desc limit 1`, [r1.id]);
    expect(audit.rows[0].data.changed).toEqual({ score: { before: 0.9, after: 0.95 }, run: { before: null, after: 2 } });
  });

  it("refuses what the project's schema refuses, message by message", async () => {
    const out = await ingestCustom(db, src, [result("3", 0.5, {}), result("4", 0.5), { kind: "event", type: "custom.run", payload: {}, objects: [tess] }, { kind: "nope" }]);
    expect(out.accepted).toBe(1);
    expect(out.rejected.map((r) => r.index)).toEqual([0, 2, 3]);
    expect(out.rejected[1].error).toMatch(/key/);
  });

  it("keeps the token inside its project", async () => {
    const out = await ingestCustom(db, src, [
      { ...result("5", 0.5), links: { project: other } },
      { kind: "object", type: "custom.project", externalId: "x", name: "nuovo", properties: { area: "x", stage: "running" } },
      { ...run("run-3"), objects: [other] },
      { kind: "object", type: "custom.dataset", externalId: "S71", name: "TESS S71", properties: { source: "MAST" } },
    ]);
    expect(out.rejected.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(out.rejected.every((r) => /scope|works for/.test(r.error))).toBe(true);
    await createObject(A, owner, { type: "custom.result", externalId: "tic-9", name: "TIC 9", links: { project: other }, properties: { score: 1, review: "sent", extra: { tic_id: 9 } } });
    expect((await ingestCustom(db, src, [result("9", 0.1)])).rejected[0].error).toMatch(/scope/);
  });

  it("checks every reference by id against the scope", async () => {
    const theirs = await createObject(A, owner, { type: "custom.result", externalId: "tic-8", name: "TIC 8", links: { project: other }, properties: { score: 1, review: "sent", extra: { tic_id: 8 } } });
    const out = await ingestCustom(db, src, [
      { ...result("6", 0.5), links: { parent: theirs } },
      { ...run("run-4"), objects: [tess, theirs] },
      { ...run("run-5"), objects: ["not-a-uuid"] },
    ]);
    expect(out.rejected.map((r) => r.error)).toEqual([expect.stringMatching(/scope/), expect.stringMatching(/scope/), expect.stringMatching(/not found/)]);
    expect(await objectByExternalId(A, "custom.result", "tic-6")).toBeNull();
  });

  it("refuses an event time in the future or not a time", async () => {
    const out = await ingestCustom(db, src, [{ ...run("run-6"), ts: "2099-01-01T00:00:00Z" }, { ...run("run-7"), ts: "domani" }]);
    expect(out.rejected.map((r) => r.error)).toEqual([expect.stringMatching(/future/), expect.stringMatching(/invalid/)]);
    const { rows } = await db.query(`select count(*)::int n from events where tenant_id = $1 and payload->>'commit' = 'abc123' and ts > '2027-01-01'`, [ORG]);
    expect(rows[0].n).toBe(0);
  });

  it("refuses keys that reach the prototype", async () => {
    const out = await ingestCustom(db, src, [JSON.parse(`{"kind":"object","type":"custom.result","externalId":"tic-7","name":"x","properties":{"score":1,"extra":{"tic_id":7,"__proto__":{"polluted":1}}}}`)]);
    expect(out.rejected[0].error).toMatch(/not a valid key/);
    await expect(csvMessages(db, src, "custom.result", "external_id;__proto__.polluted\ntic-7;1\n")).rejects.toMatchObject({ status: 400 });
    await expect(csvMessages(db, src, "custom.result", "external_id;extra.constructor\ntic-7;1\n")).rejects.toMatchObject({ status: 400 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("never reaches another tenant", async () => {
    const out = await ingestCustom(db, otherSrc, [{ ...run("b"), objects: [tess] }, { ...result("1", 0.1), links: { project: tess } }]);
    expect(out.accepted).toBe(0);
    expect(await objectByExternalId(B, "custom.result", "tic-1")).toBeNull();
    expect((await objectByExternalId(A, "custom.result", "tic-1"))!.properties.score).toBe(0.95);
  });

  it("caps the batch", async () => {
    await db.query(`update engine_settings set value = '2' where key = 'ingest.max_batch'`);
    await getSettings(db, true);
    await expect(ingestCustom(db, src, [run(), run(), run()])).rejects.toMatchObject({ status: 413 });
    await db.query(`update engine_settings set value = '500' where key = 'ingest.max_batch'`);
    await getSettings(db, true);
  });

  it("reads a CSV of results with the project's own fields", async () => {
    const csv = "external_id;name;score;extra.tic_id;default.review\ntic-20;TIC 20;0,75;20;to_review\ntic-1;;0,95;1;to_review\n";
    const messages = await csvMessages(db, src, "custom.result", csv);
    expect(messages[0]).toMatchObject({ properties: { score: 0.75, extra: { tic_id: 20 } }, defaults: { review: "to_review" } });
    const out = await ingestCustom(db, src, messages);
    expect(out.results.map((r) => r.status)).toEqual(["created", "unchanged"]);
    await expect(csvMessages(db, src, "custom.result", "name\nx\n")).rejects.toMatchObject({ status: 400 });
  });

  it("attaches a plot to a result once, stored once", async () => {
    const store = new MemoryStore();
    const png = { name: "tic 1 lc.png", type: "image/png", bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) };
    const ref = { type: "custom.result", externalId: "tic-1" };
    const first = await pushDocument(db, store, src, png, ref);
    const again = await pushDocument(db, store, src, png, ref);
    expect(first.status).toBe("created");
    expect(again).toEqual({ ...first, status: "duplicate" });
    expect(store.objects.size).toBe(1);
    expect([...store.objects.keys()][0]).toMatch(new RegExp(`^docs/${ORG}/${src.id}/[0-9a-f]{64}-tic_1_lc.png$`));
    const links = await db.query(`select document_id from document_objects where object_id = $1`, [first.objectId]);
    expect(links.rows.map((r) => r.document_id)).toEqual([first.documentId]);
    const audit = await db.query(`select action from audit_log where data->>'document' = $1 order by id`, [first.documentId]);
    expect(audit.rows.map((r) => r.action)).toEqual(["document.create", "document.attach"]);
    await expect(pushDocument(db, store, src, png, { type: "custom.result", externalId: "tic-9" })).rejects.toMatchObject({ status: 403 });
    await db.query(`update engine_settings set value = '4' where key = 'push.document_max_bytes'`);
    await getSettings(db, true);
    await expect(pushDocument(db, store, src, { ...png, bytes: new Uint8Array(9) }, ref)).rejects.toMatchObject({ status: 413 });
  });
});
