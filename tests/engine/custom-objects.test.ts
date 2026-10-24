// Object types made in the schema editor: a project, its datasets and results, with declared
// links and a result schema the project itself holds. The database refuses what the engine
// refuses, so a write that skips the engine cannot break the rules either.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
vi.mock("server-only", () => ({}));
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import { recordEvent, type Author } from "../../lib/engine/manual";
import { listAudit } from "../../lib/engine/audit";
import { getSettings } from "../../lib/engine/settings";
import { getEventType, saveEventType, specOf } from "../../lib/engine/registers";
import {
  createObject, deleteObject, getObject, listObjects, listObjectTypes, saveObjectType, setLink, updateObject,
} from "../../lib/engine/custom-objects";

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb, B: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const owner: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "o@x.it", role: "owner" };
const member: Author = { id: "00000000-0000-0000-0000-0000000000f2", email: "m@x.it", role: "member" };
const viewer: Author = { id: "00000000-0000-0000-0000-0000000000f3", email: "v@x.it", role: "viewer" };

const project = {
  key: "project",
  name: { it: "Progetto", en: "Project" },
  properties: {
    area: { type: "string" as const },
    stage: { type: "string" as const, enum: ["preparation", "running", "done"] },
    result_schema: { type: "object" as const, format: "schema" as const },
  },
};
const dataset = { key: "dataset", name: { it: "Dataset", en: "Dataset" }, properties: { source: { type: "string" as const } } };
const result = {
  key: "result",
  name: { it: "Risultato", en: "Result" },
  properties: {
    score: { type: "number" as const, required: true },
    review: { type: "string" as const, enum: ["da_rivedere", "scartato", "interessante", "inviato"] },
    extra: { type: "object" as const, schemaFrom: "project.result_schema" },
  },
  links: { project: { type: "custom.project", required: true } },
};

let tess: string, sector: string;

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  A = forTenant(db, ORG);
  B = forTenant(db, OTHER);
});
afterAll(async () => drop?.());

describe("custom object types", () => {
  it("only the owner defines types; bad definitions are refused; audited", async () => {
    await expect(saveObjectType(A, member, project)).rejects.toMatchObject({ status: 403 });
    await expect(saveObjectType(A, owner, { ...project, key: "Bad" })).rejects.toMatchObject({ status: 400 });
    await expect(saveObjectType(A, owner, { ...project, properties: { a: { type: "string", format: "schema" } } })).rejects.toMatchObject({ status: 400 });
    // a result cannot follow a project schema before the project type exists
    await expect(saveObjectType(A, owner, result)).rejects.toMatchObject({ status: 400 });
    expect(await saveObjectType(A, owner, project)).toBe("custom.project");
    await saveObjectType(A, owner, dataset);
    await expect(saveObjectType(A, owner, { ...result, links: { part_of: result.links.project } })).rejects.toMatchObject({ status: 400 });
    await expect(saveObjectType(A, owner, { ...result, properties: { ...result.properties, extra: { type: "object", schemaFrom: "project.area" } } }))
      .rejects.toMatchObject({ status: 400 });
    await saveObjectType(A, owner, result);
    const types = await listObjectTypes(A);
    expect(types.map((t) => t.type)).toEqual(["custom.dataset", "custom.project", "custom.result"]);
    expect(Object.keys(types[2].properties)).toEqual(["score", "review", "extra"]);
    expect(types[2].links.project).toEqual({ type: "custom.project", required: true });
    expect(await listObjectTypes(B)).toEqual([]);
    expect((await listAudit(A)).filter((e) => e.action === "object_type.create")).toHaveLength(3);
  });

  it("caps the types a tenant creates", async () => {
    await db.query(`update engine_settings set value = '3' where key = 'registers.object_types_max'`);
    await getSettings(db, true);
    await expect(saveObjectType(A, owner, { ...dataset, key: "extra_type" })).rejects.toMatchObject({ status: 429 });
    await saveObjectType(A, owner, { ...dataset, name: { it: "Insieme di dati" } }); // an update is not a new type
    await db.query(`update engine_settings set value = '30' where key = 'registers.object_types_max'`);
    await getSettings(db, true);
  });
});

describe("custom objects", () => {
  it("creates a project holding a result schema; viewers and bad schemas are refused", async () => {
    await expect(createObject(A, viewer, { type: "custom.project", name: "TESS", properties: {} })).rejects.toMatchObject({ status: 403 });
    await expect(createObject(A, owner, { type: "custom.project", name: "TESS", properties: { result_schema: { tic: { type: "nope" } } } }))
      .rejects.toMatchObject({ status: 400 });
    await expect(createObject(A, owner, { type: "custom.project", name: " ", properties: {} })).rejects.toMatchObject({ status: 400 });
    tess = await createObject(A, owner, {
      type: "custom.project", name: "TESS anomalie", externalId: "tess",
      properties: { area: "astro", stage: "running", result_schema: { tic_id: { type: "integer", required: true }, sector: { type: "integer" } } },
    });
    sector = await createObject(A, member, { type: "custom.dataset", name: "Settore 70", properties: { source: "MAST" } });
    await expect(createObject(A, owner, { type: "custom.project", name: "Again", externalId: "tess", properties: {} })).rejects.toMatchObject({ status: 409 });
  });

  it("checks links and the schema the project holds", async () => {
    const base = { type: "custom.result", name: "TIC 1", properties: { score: 0.9, extra: { tic_id: 1 } } };
    await expect(createObject(A, owner, base)).rejects.toMatchObject({ status: 400, message: 'link "project" is required' });
    await expect(createObject(A, owner, { ...base, links: { project: sector } })).rejects.toMatchObject({ status: 400 });
    await expect(createObject(A, owner, { ...base, links: { project: tess, run: tess } })).rejects.toMatchObject({ status: 400 });
    await expect(createObject(A, owner, { ...base, links: { project: "00000000-0000-0000-0000-000000000099" } })).rejects.toMatchObject({ status: 404 });
    await expect(createObject(A, owner, { ...base, properties: { score: 1, extra: { sector: 70 } }, links: { project: tess } }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("tic_id") });
    const id = await createObject(A, owner, { ...base, links: { project: tess } });
    expect(await getObject(A, id)).toMatchObject({ type: "custom.result", name: "TIC 1", links: { project: tess }, properties: { score: 0.9 } });
    expect(await getObject(B, id)).toBeNull();
  });

  it("the database refuses what skips the engine", async () => {
    const { rows } = await db.query(`select id from object_types where tenant_id = $1 and key = 'result'`, [ORG]);
    const raw = (props: object) =>
      db.query(`insert into objects (tenant_id, type_id, name, properties) values ($1, $2, 'raw', $3) returning id`, [ORG, rows[0].id, props]);
    const { rows: [r] } = await raw({ score: 1, extra: { sector: 1 } }); // no project yet: checked when linked
    await expect(db.query(`insert into links (tenant_id, type, src_id, dst_id) values ($1, 'project', $2, $3)`, [ORG, r.id, tess]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(db.query(`insert into links (tenant_id, type, src_id, dst_id) values ($1, 'other', $2, $3)`, [ORG, r.id, tess]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(db.query(`insert into links (tenant_id, type, src_id, dst_id) values ($1, 'project', $2, $3)`, [ORG, r.id, sector]))
      .rejects.toMatchObject({ code: "23514" });
    const { rows: [p] } = await db.query(`select type_id from objects where id = $1`, [tess]);
    await expect(db.query(`update objects set properties = '{"result_schema": {"Bad": {"type": "string"}}}' where id = $1 and type_id = $2`, [tess, p.type_id]))
      .rejects.toMatchObject({ code: "23514" });
    await db.query(`delete from objects where id = $1`, [r.id]);
  });

  it("updates keep the other properties; review changes are audited with before and after", async () => {
    const id = await createObject(A, owner, { type: "custom.result", name: "TIC 2", properties: { score: 0.4, extra: { tic_id: 2 } }, links: { project: tess } });
    await expect(updateObject(A, member, id, { properties: { review: "forse" } })).rejects.toMatchObject({ status: 400 });
    await expect(updateObject(A, member, id, { properties: { extra: { sector: 3 } } })).rejects.toMatchObject({ status: 400 });
    await updateObject(A, member, id, { properties: { review: "interessante" } });
    expect((await getObject(A, id))!.properties).toEqual({ score: 0.4, extra: { tic_id: 2 }, review: "interessante" });
    await updateObject(A, member, id, { properties: { review: null } });
    expect((await getObject(A, id))!.properties.review).toBeUndefined();
    const audit = await listAudit(A, { objectId: id });
    expect(audit.map((e) => e.action)).toEqual(["object.update", "object.update", "object.create"]);
    expect(audit[1].data.changed).toEqual({ review: { before: null, after: "interessante" } });
    await expect(updateObject(B, owner, id, { properties: { review: "scartato" } })).rejects.toMatchObject({ status: 404 });
  });

  it("links can be moved but a required one not removed; deletes need nothing pointing at the object", async () => {
    const other = await createObject(A, owner, { type: "custom.project", name: "Altro", properties: { result_schema: { tic_id: { type: "integer" } } } });
    const id = await createObject(A, owner, { type: "custom.result", name: "TIC 3", properties: { score: 0.1 }, links: { project: tess } });
    await expect(setLink(A, owner, id, "project", null)).rejects.toMatchObject({ status: 400 });
    await setLink(A, owner, id, "project", other);
    expect((await getObject(A, id))!.links).toEqual({ project: other });
    await expect(deleteObject(A, owner, other)).rejects.toMatchObject({ status: 409 });
    await deleteObject(A, owner, id);
    await deleteObject(A, owner, other);
    expect(await getObject(A, other)).toBeNull();
    expect((await listAudit(A)).some((e) => e.action === "object.delete" && e.objectId === other)).toBe(true);
  });

  it("lists a type's objects newest first, optionally those linked to one object", async () => {
    expect((await listObjects(A, "custom.result")).map((o) => o.name)).toEqual(["TIC 2", "TIC 1"]);
    const linked = await listObjects(A, "custom.result", { linkedTo: { key: "project", id: tess } });
    expect(linked.map((o) => o.links.project)).toEqual([tess, tess]);
    expect(await listObjects(A, "custom.result", { linkedTo: { key: "project", id: sector } })).toEqual([]);
    expect(await listObjects(A, "custom.result", { linkedTo: { key: "project", id: "x" } })).toEqual([]);
    expect(await listObjects(A, "custom.result", { limit: 1 })).toHaveLength(1);
    expect(await listObjects(B, "custom.result")).toEqual([]);
    expect(await listObjects(A, "core.site")).toEqual([]);
  });

  it("caps the objects a tenant holds", async () => {
    await db.query(`update engine_settings set value = '1' where key = 'custom.objects_max'`);
    await getSettings(db, true);
    await expect(createObject(A, owner, { type: "custom.dataset", name: "S71", properties: {} })).rejects.toMatchObject({ status: 429 });
    await db.query(`update engine_settings set value = '5000' where key = 'custom.objects_max'`);
    await getSettings(db, true);
  });
});

describe("events on custom objects", () => {
  it("a run is recorded on a project and the datasets it read; other types are refused", async () => {
    await saveEventType(A, owner, {
      key: "run",
      name: { it: "Esecuzione", en: "Run" },
      subject: "custom.project",
      also: ["custom.dataset"],
      fields: { commit: { type: "string", required: true }, parametri: { type: "object" }, n_elementi: { type: "integer", min: 0 } },
    });
    const spec = specOf((await getEventType(A, [], "custom.run"))!, []);
    const input = { ts: new Date(), payload: { commit: "abc123", parametri: { sigma: 3 }, n_elementi: 1200 } };
    const id = await recordEvent(A, spec, member, { ...input, objectIds: [tess, sector] });
    expect(id).toBeGreaterThan(0);
    await expect(recordEvent(A, spec, member, { ...input, objectIds: [sector, tess] })).rejects.toMatchObject({ status: 400 });
    await expect(saveEventType(A, owner, { key: "bad", name: { en: "Bad" }, subject: "custom.project", also: ["custom.project"], fields: {} }))
      .rejects.toMatchObject({ status: 400 });
    // an object with events is not deleted
    await expect(deleteObject(A, owner, sector)).rejects.toMatchObject({ status: 409 });
  });
});
