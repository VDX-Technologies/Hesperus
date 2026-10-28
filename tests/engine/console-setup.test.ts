import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
vi.mock("server-only", () => ({}));
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import type { Author } from "../../lib/engine/manual";
import { getObjectType, listObjectTypes, saveObjectType } from "../../lib/engine/custom-objects";
import { prepareConsole } from "../../lib/console-setup";
import { consoleHome, enabledConsoles, hasConsole, parseConsoles } from "../../lib/consoles";

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb, B: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const admin: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "vdx@x.it", role: "owner" };

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  A = forTenant(db, ORG);
  B = forTenant(db, OTHER);
});
afterAll(async () => drop?.());

describe("console setup", () => {
  it("organizations start with Terra only", async () => {
    const { rows } = await db.query(`select consoles from organizations where id = $1`, [ORG]);
    expect(rows[0].consoles).toEqual(["terra"]);
    expect(hasConsole(rows[0], "research")).toBe(false);
    expect(parseConsoles(["research", "nope", "terra", "research"])).toEqual(["terra", "research"]);
  });

  it("users land on the first console the organization has, or nowhere when it has none", () => {
    expect(consoleHome({ consoles: ["terra", "research"] }, "a")).toBe("/terra/o/a");
    expect(consoleHome({ consoles: ["research"] }, "a")).toBe("/research/o/a");
    expect(consoleHome({ consoles: [] }, "a")).toBeNull();
    expect(enabledConsoles({ consoles: ["research"] }).map((c) => c.id)).toEqual(["research"]);
  });

  it("loads the research types once, only in its tenant, and keeps the customer's edits", async () => {
    expect(await prepareConsole(A, admin, "research")).toContain("custom.project");
    expect((await listObjectTypes(A)).length).toBe(4);
    expect(await listObjectTypes(B)).toEqual([]);

    const project = (await getObjectType(A, "custom.project"))!;
    await saveObjectType(A, admin, { ...project, name: { en: "Study", it: "Studio" } });
    expect(await prepareConsole(A, admin, "research")).toEqual([]);
    expect((await getObjectType(A, "custom.project"))!.name).toEqual({ en: "Study", it: "Studio" });
  });

  it("Terra and unknown consoles prepare nothing", async () => {
    expect(await prepareConsole(B, admin, "terra")).toEqual([]);
    expect(await prepareConsole(B, admin, "nope")).toEqual([]);
    expect(await listObjectTypes(B)).toEqual([]);
  });
});
