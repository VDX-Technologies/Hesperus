// Per-source token bucket on push: burst, refill, 429 wait, last_error and the health flag.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { createSource, type Source } from "../../lib/engine/sources";
import { takeIngestToken } from "../../lib/engine/ingest";
import { collectHealth } from "../../lib/engine/health";

let db: Client;
let drop: () => Promise<void>;
let a: Source;
let b: Source;
const ORG = "00000000-0000-0000-0000-00000000000a";
const T0 = new Date("2026-10-17T10:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a')`, [ORG]);
  await db.query(`update engine_settings set value = to_jsonb($2::numeric) where key = $1`, ["ingest.burst", 3]);
  await db.query(`update engine_settings set value = to_jsonb($2::numeric) where key = $1`, ["ingest.rate_per_min", 60]);
  await db.query(`update engine_settings set value = to_jsonb($2::numeric) where key = $1`, ["health.rate_limited_per_h", 2]);
  ({ source: a } = await createSource(db, { tenantId: ORG, name: "a", module: "testmod" }));
  ({ source: b } = await createSource(db, { tenantId: ORG, name: "b", module: "testmod" }));
});
afterAll(async () => drop?.());

describe("ingest rate limit", () => {
  it("allows the burst, then asks to wait until a token refills", async () => {
    for (let i = 0; i < 3; i++) expect(await takeIngestToken(db, a.id, T0)).toBe(0);
    const wait = await takeIngestToken(db, a.id, T0);
    expect(wait).toBeCloseTo(1, 5); // 60/min = one token per second
    expect((await db.query(`select last_error from sources where id = $1`, [a.id])).rows[0].last_error).toBe("rate limited");
  });

  it("refills over time, capped at the burst", async () => {
    expect(await takeIngestToken(db, a.id, at(1))).toBe(0);
    expect(await takeIngestToken(db, a.id, at(1))).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) expect(await takeIngestToken(db, a.id, at(100))).toBe(0);
    expect(await takeIngestToken(db, a.id, at(100))).toBeGreaterThan(0);
  });

  it("keeps one bucket per source", async () => {
    expect(await takeIngestToken(db, b.id, at(100))).toBe(0);
  });

  it("health flags a source limited more than health.rate_limited_per_h times this hour", async () => {
    const check = async (id: string) => (await collectHealth(db, undefined, at(100))).checks.find((c) => c.key === `ratelimit.${id}`);
    expect((await check(a.id))?.ok).toBe(false); // limited 3 times
    expect((await check(b.id))?.ok).toBe(true);
    expect((await collectHealth(db, undefined, at(3700))).checks.find((c) => c.key === `ratelimit.${a.id}`)?.ok).toBe(true);
  });
});
