// The research pipeline's push source, as the admin engine page creates it: module "custom",
// scoped to one project of the tenant, with the token shown once and an audit entry.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
vi.mock("server-only", () => ({}));
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import type { Author } from "../../lib/engine/manual";
import { sourceByToken } from "../../lib/engine/sources";
import { createObject } from "../../lib/engine/custom-objects";
import { RESEARCH } from "../../lib/research";
import { createResearchSource } from "../../lib/research-source";
import { seedResearch } from "../../scripts/research/types";

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const owner: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "o@x.it", role: "owner" };
let tess: string, foreign: string, dataset: string;

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'lab-a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  A = forTenant(db, ORG);
  const B = forTenant(db, OTHER);
  await seedResearch(A, owner);
  await seedResearch(B, owner);
  const props = { area: "astrofisica", stage: "running" };
  tess = await createObject(A, owner, { type: RESEARCH.project, name: "TESS", externalId: "tess", properties: props });
  foreign = await createObject(B, owner, { type: RESEARCH.project, name: "Altrui", properties: props });
  dataset = await createObject(A, owner, { type: RESEARCH.dataset, name: "S103", properties: { source: "MAST" } });
});
afterAll(async () => drop?.());

describe("research source", () => {
  it("binds a push token to the project and its datasets", async () => {
    const { source, token, project } = await createResearchSource(db, ORG, tess, { name: "  ", actor: { id: owner.id, email: owner.email } });
    expect(project.id).toBe(tess);
    expect(source).toMatchObject({ name: "TESS pipeline", module: "custom", connector: "push", tenant_id: ORG });
    expect(source.config).toEqual({ scope: { link: "project", id: tess, also: [RESEARCH.dataset] } });
    expect((await sourceByToken(db, token))?.id).toBe(source.id);
    const { rows } = await db.query(`select actor, object_id, subject from audit_log where action = 'source.create'`);
    expect(rows).toEqual([{ actor: owner.id, object_id: tess, subject: "TESS pipeline" }]);
  });

  it("finds the project by external id and keeps a given name", async () => {
    const { source } = await createResearchSource(db, ORG, "tess", { name: "s103" });
    expect(source.name).toBe("s103");
    expect((source.config as { scope: { id: string } }).scope.id).toBe(tess);
  });

  it("refuses what is not one of the tenant's projects", async () => {
    await expect(createResearchSource(db, ORG, "nope")).rejects.toThrow(/no project/);
    await expect(createResearchSource(db, ORG, foreign)).rejects.toThrow(/no project/);
    await expect(createResearchSource(db, ORG, dataset)).rejects.toThrow(/no project/);
  });
});
