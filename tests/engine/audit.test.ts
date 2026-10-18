// Audit log: rows are append-only, scoped to their tenant (also under RLS), alert acks are
// recorded by the database, and retention trims old rows only through the purge.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import { listAudit, record, recordPlatform } from "../../lib/engine/audit";

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb;
let B: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const USER = "00000000-0000-0000-0000-000000000001";
const OBJ = "00000000-0000-0000-0000-0000000000f1";

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  await db.query(`insert into auth.users (id, email) values ($1, 'ann@example.com')`, [USER]);
  await db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'member')`, [ORG, USER]);
  A = forTenant(db, ORG);
  B = forTenant(db, OTHER);
});
afterAll(async () => drop?.());

const asUser = async <T>(fn: () => Promise<T>) => {
  await db.query("begin");
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [USER]);
    await db.query("set local role authenticated");
    return await fn();
  } finally {
    await db.query("rollback");
  }
};

describe("audit log", () => {
  it("records and lists newest first, per tenant and per object", async () => {
    await record(A, { id: USER, email: "ann@example.com" }, "place.create", { objectId: OBJ, subject: "Farm" });
    await record(A, null, "object.update", { objectId: OBJ, data: { place: null } });
    await record(B, null, "member.add", { subject: "bob@example.com" });
    const all = await listAudit(A);
    expect(all.map((e) => e.action)).toEqual(["object.update", "place.create"]);
    expect(all[1]).toMatchObject({ actor: USER, actorLabel: "ann@example.com", subject: "Farm", objectId: OBJ });
    expect((await listAudit(A, { objectId: OBJ, limit: 1 })).map((e) => e.action)).toEqual(["object.update"]);
    expect((await listAudit(A, { before: all[0].id })).map((e) => e.action)).toEqual(["place.create"]);
    expect((await listAudit(B)).map((e) => e.action)).toEqual(["member.add"]);
  });

  it("refuses updates and deletes", async () => {
    await expect(db.query(`update audit_log set action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from audit_log`)).rejects.toThrow(/append-only/);
    expect((await listAudit(A)).length).toBe(2);
  });

  it("lets members read only their organization's rows, and write none", async () => {
    await recordPlatform(db, null, "settings.update", { "retention.raw_days": 30 });
    const seen = await asUser(async () => (await db.query(`select tenant_id, action from audit_log order by id`)).rows);
    expect(seen.every((r) => r.tenant_id === ORG)).toBe(true);
    expect(seen.length).toBe(2);
    await expect(asUser(() => db.query(`insert into audit_log (tenant_id, action) values ($1, 'forged')`, [ORG]))).rejects.toThrow();
  });

  it("records alert acknowledgements made by the user", async () => {
    await db.query(
      `with t as (insert into object_types (tenant_id, module, key) values (null, 'auditmod', 'thing') returning id)
       insert into objects (id, tenant_id, type_id, name) select $2, $1, id, 'Thing' from t`,
      [ORG, OBJ],
    );
    const { rows } = await db.query(
      `insert into object_alerts (tenant_id, object_id, severity, title, opened_at) values ($1, $2, 'warn', 'hot', now()) returning id`,
      [ORG, OBJ],
    );
    expect(rows.length).toBe(1);
    await asUser(async () => {
      expect((await db.query(`select ack_alert($1) as ok`, [rows[0].id])).rows[0].ok).toBe(true);
      const { rows: log } = await db.query(`select actor, actor_label, object_id from audit_log where action = 'alert.ack'`);
      expect(log).toEqual([{ actor: USER, actor_label: "ann@example.com", object_id: OBJ }]);
    });
  });

  it("purges rows past retention.audit_days, and keeps all when it is null", async () => {
    await db.query(`alter table audit_log disable trigger audit_log_append_only`);
    await db.query(`update audit_log set at = now() - interval '400 days' where action = 'place.create'`);
    await db.query(`alter table audit_log enable trigger audit_log_append_only`);
    await db.query(`update engine_settings set value = 'null' where key = 'retention.audit_days'`);
    expect((await db.query(`select audit_purge() as n`)).rows[0].n).toBe(0);
    await db.query(`update engine_settings set value = '365' where key = 'retention.audit_days'`);
    expect((await db.query(`select audit_purge() as n`)).rows[0].n).toBe(1);
    expect((await listAudit(A)).map((e) => e.action)).toEqual(["object.update"]);
    // the purge flag does not leak: a plain delete still fails afterwards
    await expect(db.query(`delete from audit_log`)).rejects.toThrow(/append-only/);
    expect((await db.query(`select engine_maintenance() -> 'audit_purged' as n`)).rows[0].n).toBe(0);
  });
});
