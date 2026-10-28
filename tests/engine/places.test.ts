import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import { createSource } from "../../lib/engine/sources";
import { ingestPush, registerPackage } from "../../lib/engine/ingest";
import { createPlace, deletePlace, flattenPlaces, movePlace, placeTree, renamePlace, setObjectPlace } from "../../lib/engine/places";
import { testPkg } from "./fixture";

vi.mock("server-only", () => ({}));
const { listObjects } = await import("../../lib/packages/console");

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const sensors: string[] = [];

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  await registerPackage(db, testPkg);
  const { source } = await createSource(db, { tenantId: ORG, name: "gw", module: "testmod" });
  await ingestPush(db, source, [{ sensor: "s1", temp: 20 }, { sensor: "s2", temp: 21 }], testPkg, new Date());
  sensors.push(...(await db.query(`select id from objects where tenant_id = $1 order by external_id`, [ORG])).rows.map((r) => r.id));
  A = forTenant(db, ORG);
});
afterAll(async () => drop?.());

describe("place tree", () => {
  it("builds sites and nested areas, and reads the object's path", async () => {
    const farm = await createPlace(A, { kind: "site", name: "Farm" });
    const north = await createPlace(A, { kind: "area", name: "North", parentId: farm });
    const bed = await createPlace(A, { kind: "area", name: "Bed 1", parentId: north });
    await setObjectPlace(A, sensors[0], bed);
    const [s1, s2] = await listObjects(A, "testmod");
    expect(s1.placeId).toBe(bed);
    expect(s1.placePath).toEqual(["Farm", "North", "Bed 1"]);
    expect(s2.placePath).toEqual([]);
    expect(flattenPlaces(await placeTree(A)).map((p) => p.path.join("/"))).toEqual(["Farm", "Farm/North", "Farm/North/Bed 1"]);

    await renamePlace(A, north, "Nord");
    await setObjectPlace(A, sensors[0], north);
    expect((await listObjects(A, "testmod"))[0].placePath).toEqual(["Farm", "Nord"]);
  });

  it("refuses cycles, wrong kinds and places of another tenant", async () => {
    const site = await createPlace(A, { kind: "site", name: "S" });
    const a1 = await createPlace(A, { kind: "area", name: "a1", parentId: site });
    const a2 = await createPlace(A, { kind: "area", name: "a2", parentId: a1 });
    await expect(movePlace(A, a1, a2)).rejects.toThrow(/cycle/);
    await expect(movePlace(A, a1, a1)).rejects.toThrow(/cycle/);
    await expect(movePlace(A, site, a1)).rejects.toThrow(/part_of/);
    await expect(movePlace(A, sensors[1], site)).rejects.toThrow(/part_of/);
    await expect(setObjectPlace(A, a1, site)).rejects.toThrow(/located_in/);
    await expect(setObjectPlace(A, sensors[1], sensors[0])).rejects.toThrow(/located_in/);
    const foreign = await createPlace(forTenant(db, OTHER), { kind: "site", name: "B" });
    await expect(setObjectPlace(A, sensors[1], foreign)).rejects.toThrow();
  });

  it("moves areas and objects up to the parent when a place is deleted", async () => {
    const site = await createPlace(A, { kind: "site", name: "D" });
    const mid = await createPlace(A, { kind: "area", name: "mid", parentId: site });
    const leaf = await createPlace(A, { kind: "area", name: "leaf", parentId: mid });
    await setObjectPlace(A, sensors[1], mid);
    await deletePlace(A, mid);
    expect((await listObjects(A, "testmod"))[1].placePath).toEqual(["D"]);
    const d = (await placeTree(A)).find((p) => p.id === site)!;
    expect(d.children.map((c) => c.id)).toEqual([leaf]);

    await deletePlace(A, site);
    expect((await listObjects(A, "testmod"))[1].placeId).toBeNull();
  });

  it("deletePlace never deletes non-place objects", async () => {
    await deletePlace(A, sensors[0]);
    expect((await db.query(`select 1 from objects where id = $1`, [sensors[0]])).rowCount).toBe(1);
  });
});

describe("sites and zones migration", () => {
  it("keeps ids, links zones to sites and objects to zones, drops zone_id", async () => {
    await db.query(`create table sites (id uuid primary key default gen_random_uuid(), org_id uuid not null, name text not null, created_at timestamptz not null default now())`);
    await db.query(`create table zones (id uuid primary key default gen_random_uuid(), org_id uuid not null, site_id uuid not null references sites (id), name text not null, created_at timestamptz not null default now())`);
    const site = (await db.query(`insert into sites (org_id, name) values ($1, 'Old site') returning id`, [ORG])).rows[0].id;
    const zone = (await db.query(`insert into zones (org_id, site_id, name) values ($1, $2, 'Old zone') returning id`, [ORG, site])).rows[0].id;
    await db.query(`update object_types set properties = properties || '{"zone_id": {"type": "string"}}' where module = 'testmod'`);
    await setObjectPlace(A, sensors[1], null);
    await db.query(`update objects set properties = properties || jsonb_build_object('zone_id', $2::text) where id = $1`, [sensors[1], zone]);

    const sql = readFileSync(join(__dirname, "../../supabase/migrations/20261020010000_places_data.sql"), "utf8");
    await db.query(sql);
    await db.query(sql);

    const [, s2] = await listObjects(A, "testmod");
    expect(s2.placeId).toBe(zone);
    expect(s2.placePath).toEqual(["Old site", "Old zone"]);
    expect(s2.properties.zone_id).toBeUndefined();

    const drop = readFileSync(join(__dirname, "../../supabase/migrations/20261023000000_drop_sites_zones.sql"), "utf8");
    await db.query(`insert into sites (org_id, name) values ($1, 'Never moved')`, [ORG]);
    await expect(db.query(drop)).rejects.toThrow(/1 rows not moved/);
    await db.query(`delete from sites where name = 'Never moved'`);
    await db.query(drop);
    expect((await db.query(`select to_regclass('public.sites') t`)).rows[0].t).toBeNull();
  });
});
