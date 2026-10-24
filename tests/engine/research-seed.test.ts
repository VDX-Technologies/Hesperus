// The VDX Research seed: configuration only, saved through the editor's APIs. Running it twice
// changes nothing; a TESS project then holds its own result fields (TIC id) and a run links the
// project to the datasets it read.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
vi.mock("server-only", () => ({}));
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import { recordEvent, type Author } from "../../lib/engine/manual";
import { getEventType, specOf } from "../../lib/engine/registers";
import { createObject, listObjects, listObjectTypes } from "../../lib/engine/custom-objects";
import { seedResearch } from "../../scripts/research/types";

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb, B: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const owner: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "o@x.it", role: "owner" };
const member: Author = { id: "00000000-0000-0000-0000-0000000000f2", email: "m@x.it", role: "member" };

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  A = forTenant(db, ORG);
  B = forTenant(db, OTHER);
});
afterAll(async () => drop?.());

describe("research seed", () => {
  it("defines the types once, again without duplicates, only in its tenant", async () => {
    const types = ["custom.project", "custom.dataset", "custom.result", "custom.run", "custom.lab_note", "custom.comment"];
    expect(await seedResearch(A, owner)).toEqual(types);
    expect(await seedResearch(A, owner)).toEqual(types);
    expect((await listObjectTypes(A)).map((t) => t.type).sort()).toEqual(["custom.dataset", "custom.project", "custom.result"]);
    const { rows } = await db.query(`select count(*)::int n from event_types where tenant_id = $1 and module = 'custom'`, [ORG]);
    expect(rows[0].n).toBe(3);
    expect(await listObjectTypes(B)).toEqual([]);
    await expect(seedResearch(A, member)).rejects.toMatchObject({ status: 403 });
  });

  it("a TESS project, a run on its dataset and a result with the project's own fields", async () => {
    const tess = await createObject(A, member, {
      type: "custom.project", name: "TESS anomalie",
      properties: { area: "astrofisica", stage: "running", result_schema: { tic_id: { type: "integer", required: true } } },
    });
    const sector = await createObject(A, member, { type: "custom.dataset", name: "TESS S70", properties: { source: "MAST" } });
    const spec = specOf((await getEventType(A, [], "custom.run"))!, []);
    const run = await recordEvent(A, spec, member, {
      ts: new Date(), payload: { commit: "abc123", items: 18000, outcome: "ok", params: { sigma: 3 } }, objectIds: [tess, sector],
    });
    const result = { type: "custom.result", name: "TIC 123", links: { project: tess } };
    await createObject(A, member, { ...result, properties: { score: 0.93, review: "to_review", run, extra: { tic_id: 123 } } });
    // the project's own fields are enforced
    await expect(createObject(A, member, { ...result, name: "TIC x", properties: { score: 1, review: "to_review", extra: {} } }))
      .rejects.toMatchObject({ status: 400 });
    await expect(createObject(A, member, { ...result, name: "TIC y", properties: { score: 1, review: "maybe" } }))
      .rejects.toMatchObject({ status: 400 });
    expect((await listObjects(A, "custom.result", { linkedTo: { key: "project", id: tess } })).map((o) => o.properties.run)).toEqual([run]);
  });
});
