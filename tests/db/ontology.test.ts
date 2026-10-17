import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asUser, freshDb } from "./setup";

let db: Client;
let drop: () => Promise<void>;
const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const USER_A = "00000000-0000-0000-0000-0000000000a1";
const USER_B = "00000000-0000-0000-0000-0000000000b1";
let typeId: string;

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into auth.users (id) values ($1), ($2)`, [USER_A, USER_B]);
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG_A, ORG_B]);
  await db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'viewer')`, [
    ORG_A, USER_A, ORG_B, USER_B,
  ]);
  const { rows } = await db.query(
    `insert into object_types (module, key, properties) values ('test', 'sensor', $1) returning id`,
    [{
      model: { type: "string", required: true },
      height_m: { type: "number", min: 0, max: 10 },
      channels: { type: "integer" },
      mode: { type: "string", enum: ["a", "b"] },
      installed: { type: "timestamp" },
    }],
  );
  typeId = rows[0].id;
});

afterAll(async () => drop?.());

async function insertObject(tenant: string, properties: object, ext = Math.random().toString(36)) {
  const { rows } = await db.query(
    `insert into objects (tenant_id, type_id, external_id, properties) values ($1, $2, $3, $4) returning id`,
    [tenant, typeId, ext, properties],
  );
  return rows[0].id as string;
}

describe("property validation", () => {
  it("accepts valid properties", async () => {
    await expect(
      insertObject(ORG_A, { model: "x1", height_m: 1.5, channels: 4, mode: "a", installed: "2026-01-01T00:00:00Z" }),
    ).resolves.toBeTruthy();
  });

  it.each([
    [{}, /"model" is required/],
    [{ model: 3 }, /"model" must be a string/],
    [{ model: "x", height_m: 11 }, /must be <= 10/],
    [{ model: "x", channels: 1.5 }, /must be an integer/],
    [{ model: "x", mode: "c" }, /must be one of/],
    [{ model: "x", installed: "yesterday-ish" }, /must be a timestamp/],
    [{ model: "x", color: "red" }, /unknown property "color"/],
  ])("rejects %j", async (props, msg) => {
    await expect(insertObject(ORG_A, props)).rejects.toThrow(msg);
  });

  it("validates on update too", async () => {
    const id = await insertObject(ORG_A, { model: "x" });
    await expect(db.query(`update objects set properties = '{"model": 1}' where id = $1`, [id])).rejects.toThrow(
      /must be a string/,
    );
  });

  it("refuses a type owned by another tenant", async () => {
    const { rows } = await db.query(
      `insert into object_types (tenant_id, module, key) values ($1, 'test', 'private') returning id`,
      [ORG_B],
    );
    await expect(
      db.query(`insert into objects (tenant_id, type_id) values ($1, $2)`, [ORG_A, rows[0].id]),
    ).rejects.toThrow(/another tenant/);
  });
});

describe("tenant isolation", () => {
  it("users only see their tenant's objects, metrics and events", async () => {
    const a = await insertObject(ORG_A, { model: "a" });
    const b = await insertObject(ORG_B, { model: "b" });
    const { rows: [mk] } = await db.query(`insert into metric_keys (module, key) values ('test', 't') returning id`);
    await db.query(`insert into metrics values ($1, $2, $3, now(), 1), ($4, $5, $3, now(), 2)`, [ORG_A, a, mk.id, ORG_B, b]);
    const { rows: [ev] } = await db.query(
      `insert into events (tenant_id, type, severity) values ($1, 'test.x', 'warn') returning id`, [ORG_B],
    );
    await db.query(`insert into event_objects values ($1, $2, $3)`, [ORG_B, ev.id, b]);

    await asUser(db, USER_A, async () => {
      const objs = await db.query(`select tenant_id from objects`);
      expect(new Set(objs.rows.map((r) => r.tenant_id))).toEqual(new Set([ORG_A]));
      expect((await db.query(`select value from metrics`)).rows).toEqual([{ value: 1 }]);
      expect((await db.query(`select * from events`)).rowCount).toBe(0);
      expect((await db.query(`select * from engine_settings`)).rowCount).toBe(0);
      expect((await db.query(`select * from raw_inbox`)).rowCount).toBe(0);
    });
    await asUser(db, USER_B, async () => {
      expect((await db.query(`select * from events`)).rowCount).toBe(1);
      expect((await db.query(`select * from sources`)).rowCount).toBe(0); // viewer: no sources
    });
  });

  it("links cannot cross tenants", async () => {
    const a = await insertObject(ORG_A, { model: "a" });
    const b = await insertObject(ORG_B, { model: "b" });
    await expect(
      db.query(`insert into links (tenant_id, type, src_id, dst_id) values ($1, 'near', $2, $3)`, [ORG_A, a, b]),
    ).rejects.toThrow(/foreign key/);
  });

  it("viewers cannot write objects, owners can", async () => {
    await asUser(db, USER_B, async () => {
      await expect(
        db.query(`insert into objects (tenant_id, type_id, properties) values ($1, $2, '{"model":"v"}')`, [ORG_B, typeId]),
      ).rejects.toThrow(/row-level security/);
    });
    await asUser(db, USER_A, async () => {
      await db.query(`insert into objects (tenant_id, type_id, properties) values ($1, $2, '{"model":"o"}')`, [ORG_A, typeId]);
    });
  });
});

describe("metric partitions", () => {
  it("creates daily partitions ahead and is idempotent", async () => {
    const { rows } = await db.query(
      `select count(*)::int as n from pg_inherits where inhparent = 'metrics'::regclass`,
    );
    expect(rows[0].n).toBe(1 + 4); // default + today..today+3
    expect((await db.query(`select ensure_metric_partitions()`)).rows[0].ensure_metric_partitions).toBe(0);
  });

  it("routes rows into the day partition, stragglers into default", async () => {
    const a = await insertObject(ORG_A, { model: "p" });
    const { rows: [mk] } = await db.query(`insert into metric_keys (module, key) values ('test', 'p') returning id`);
    await db.query(`insert into metrics values ($1, $2, $3, now(), 1), ($1, $2, $3, now() - interval '400 days', 2)`, [
      ORG_A, a, mk.id,
    ]);
    const { rows } = await db.query(
      `select tableoid::regclass::text as part, value from metrics where object_id = $1 order by value`, [a],
    );
    expect(rows[0].part).toMatch(/^metrics_\d{8}$/);
    expect(rows[1].part).toBe("metrics_default");
  });

  it("reads its window from engine_settings", async () => {
    await db.query(`update engine_settings set value = '5' where key = 'metrics.partitions_ahead_days'`);
    expect((await db.query(`select ensure_metric_partitions()`)).rows[0].ensure_metric_partitions).toBe(2);
  });

  it("locks every partition: RLS on, no grants to API roles", async () => {
    const { rows } = await db.query(`
      select c.relname, c.relrowsecurity,
             has_table_privilege('anon', c.oid, 'select') anon,
             has_table_privilege('authenticated', c.oid, 'select') auth
      from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'public.metrics'::regclass`);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.anon, r.auth]).toEqual([r.relname, true, false, false]);
  });
});
