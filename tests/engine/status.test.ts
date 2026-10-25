import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { platformStatus, readStatus } from "../../lib/engine/status";

const now = new Date("2026-10-25T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60000).toISOString();
const row = (checks: { key: string; ok: boolean }[], last_ok = ago(30), last_error: string | null = null) => ({ last_ok, last_error, checks });

describe("platformStatus", () => {
  it("is operational when the last run is recent and every platform check passes", () => {
    const s = platformStatus(row([{ key: "quota.db_bytes", ok: true }, { key: "raw.inbox", ok: true }, { key: "job.flush", ok: true }]), now);
    expect(s.overall).toBe("ok");
    expect(s.checkedAt).toBe(ago(30));
  });

  it("ignores per-customer checks", () => {
    const s = platformStatus(row([{ key: "source.x", ok: false }, { key: "ratelimit.x", ok: false }]), now);
    expect(s.overall).toBe("ok");
  });

  it("maps failing checks to their component", () => {
    expect(platformStatus(row([{ key: "raw.inbox", ok: false }]), now).components.ingest).toBe("degraded");
    expect(platformStatus(row([{ key: "job.sweep-orphans", ok: false }]), now).components.ingest).toBe("degraded");
    const s = platformStatus(row([{ key: "quota.r2_bytes", ok: false }]), now);
    expect([s.components.storage, s.components.ingest, s.overall]).toEqual(["degraded", "ok", "degraded"]);
  });

  it("does not know the components when the health run is stale, failed or never ran", () => {
    const stale = platformStatus(row([], ago(180)), now);
    expect([stale.components.monitoring, stale.components.ingest, stale.overall]).toEqual(["degraded", "unknown", "degraded"]);
    expect(platformStatus(row([], ago(10), "boom"), now).components.monitoring).toBe("degraded");
    expect(platformStatus(undefined, now)).toMatchObject({ overall: "degraded", checkedAt: null });
  });

  it("is down when the database does not answer", () => {
    expect(platformStatus(null, now)).toMatchObject({ overall: "down", components: { database: "down" } });
  });
});

describe("readStatus", () => {
  let db: Client;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await freshDb()));
  afterAll(async () => drop?.());

  it("reads only the check keys of the last health run", async () => {
    const checks = [{ key: "raw.inbox", ok: false, message: "secret org" }, { key: "quota.db_bytes", ok: true, message: "x" }];
    await db.query(
      `insert into engine_jobs (name, last_ok, last_result) values ('health', $1, $2)
       on conflict (name) do update set last_ok = excluded.last_ok, last_result = excluded.last_result, last_error = null`,
      [ago(5), JSON.stringify({ checks })],
    );
    const s = await readStatus(db, now);
    expect(s.components).toEqual({ database: "ok", ingest: "degraded", storage: "ok", monitoring: "ok" });
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("reports the database down when the query fails", async () => {
    const broken = { query: () => Promise.reject(new Error("down")) } as unknown as Client;
    expect((await readStatus(broken, now)).overall).toBe("down");
  });
});
