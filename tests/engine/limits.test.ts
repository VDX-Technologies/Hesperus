import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type Client } from "pg";
vi.mock("server-only", () => ({}));
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import { createSource, type Source } from "../../lib/engine/sources";
import { MemoryStore } from "../../lib/engine/store";
import { createObject } from "../../lib/engine/custom-objects";
import { pushDocument } from "../../lib/engine/custom-ingest";
import { createManualEvent, createManualObject, type Author } from "../../lib/engine/manual";
import type { ModulePackage } from "../../lib/engine/package";
import { getSettings } from "../../lib/engine/settings";
import { seedResearch } from "../../scripts/research/types";

const pkg: ModulePackage = {
  id: "limmod",
  objectTypes: [{ key: "thing", name: { en: "Thing" }, properties: {} }],
  eventTypes: [{ key: "note", name: { en: "Note" }, fields: { text: { type: "string", required: true } } }],
  metrics: [],
  normalize: () => [],
};

let db: Client;
let pool: Pool;
let drop: () => Promise<void>;
let A: TenantDb;
let src: Source;
let dataset: string;
const ORG = "00000000-0000-0000-0000-00000000000a";
const owner: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "o@x.it", role: "owner" };

const setting = async (key: string, value: number) => {
  await db.query(`update engine_settings set value = to_jsonb($2::int) where key = $1`, [key, value]);
  await getSettings(db, true);
};
const outcomes = (results: PromiseSettledResult<unknown>[]) =>
  results.map((r) => (r.status === "fulfilled" ? "ok" : (r.reason as { status?: number }).status ?? String(r.reason))).sort();

beforeAll(async () => {
  const f = await freshDb();
  ({ db, drop } = f);
  pool = new Pool({ connectionString: f.url, max: 4 });
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a')`, [ORG]);
  await seedResearch(forTenant(db, ORG), owner);
  dataset = await createObject(forTenant(db, ORG), owner, { type: "custom.dataset", name: "S70", externalId: "S70", properties: { source: "MAST" } });
  ({ source: src } = await createSource(db, { tenantId: ORG, name: "pipeline", module: "custom" }));
  A = forTenant(pool, ORG);
});
afterAll(async () => {
  await pool?.end();
  await drop?.();
});

describe("limits under concurrency", () => {
  it("lets one of two concurrent pushes take the last daily slot", async () => {
    await setting("push.documents_per_day", 1);
    const store = new MemoryStore();
    const file = (n: number) => ({ name: `f${n}.txt`, type: "text/plain", bytes: new TextEncoder().encode(`file ${n}`) });
    const ref = { type: "custom.dataset", externalId: "S70" };
    const results = await Promise.allSettled([1, 2, 3].map((n) => pushDocument(pool, store, src, file(n), ref)));
    expect(outcomes(results)).toEqual([429, 429, "ok"]);
    const { rows } = await db.query(`select count(*)::int n from documents where source_id = $1`, [src.id]);
    expect(rows[0].n).toBe(1);
    expect(dataset).toBeTruthy();
    await setting("push.documents_per_day", 200);
  });

  it("lets one of two concurrent manual events take the last daily slot", async () => {
    const thing = await createManualObject(A, pkg, owner, { type: "thing", name: "T", properties: {} });
    await setting("manual.events_per_day", 1);
    const results = await Promise.allSettled([1, 2, 3].map((n) =>
      createManualEvent(A, pkg, owner, { type: "note", ts: new Date(), payload: { text: `n${n}` }, objectIds: [thing] })));
    expect(outcomes(results)).toEqual([429, 429, "ok"]);
    await setting("manual.events_per_day", 500);
  });

  it("lets one of two concurrent manual objects take the last slot", async () => {
    await setting("manual.objects_max", 2);
    const results = await Promise.allSettled([1, 2, 3].map((n) => createManualObject(A, pkg, owner, { type: "thing", name: `T${n}`, properties: {} })));
    expect(outcomes(results)).toEqual([429, 429, "ok"]);
    await setting("manual.objects_max", 500);
  });
});
