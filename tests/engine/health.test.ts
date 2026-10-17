import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { createSource, hashToken, rotateToken, sourceByToken, type Source } from "../../lib/engine/sources";
import { alertRecipients, collectHealth, monthUsage, recordUsage, runHealth, updateNotices } from "../../lib/engine/health";
import { ResendMailer, type Mail, type Mailer } from "../../lib/engine/mail";
import { MemoryStore, MeteredStore } from "../../lib/engine/store";

let db: Client;
let drop: () => Promise<void>;
let source: Source;
const ORG = "00000000-0000-0000-0000-00000000000a";
const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const at = (s: string) => new Date(`2026-10-17T${s}Z`);
const set = (key: string, value: unknown) =>
  db.query(`update engine_settings set value = $2 where key = $1`, [key, JSON.stringify(value)]);

class FakeMailer implements Mailer {
  sent: Mail[] = [];
  fail = false;
  async send(m: Mail) {
    if (this.fail) throw new Error("smtp down");
    this.sent.push(m);
  }
}

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a')`, [ORG]);
  await db.query(`insert into auth.users (id, email) values ($1, 'admin@x.it')`, [ADMIN]);
  await db.query(`insert into platform_admins (user_id) values ($1)`, [ADMIN]);
  ({ source } = await createSource(db, { tenantId: ORG, name: "gw", module: "testmod" }));
});
afterAll(async () => {
  await drop?.();
});
beforeEach(async () => {
  await db.query(`delete from engine_notices; delete from raw_inbox; update sources set last_seen = null`);
  await set("quota.db_bytes", 1e12);
});

const check = async (key: string, now: Date, store?: MemoryStore) =>
  (await collectHealth(db, store, now)).checks.find((c) => c.key === key);

describe("health checks", () => {
  it("flags a quota past the alert ratio", async () => {
    expect((await check("quota.db_bytes", at("10:00:00")))?.ok).toBe(true);
    await set("quota.db_bytes", 1000);
    const c = await check("quota.db_bytes", at("10:00:00"));
    expect(c?.ok).toBe(false);
    expect(c?.value).toBeGreaterThan(1000);
  });

  it("measures object storage when a store is given", async () => {
    const store = new MemoryStore();
    await store.putNew("raw/a", new Uint8Array(10));
    await store.putNew("raw/b", new Uint8Array(5));
    expect(await store.usage("raw/")).toEqual({ objects: 2, bytes: 15 });
    await set("quota.r2_bytes", 16);
    expect((await check("quota.r2_bytes", at("10:00:00"), store))?.ok).toBe(false); // 15 >= 0.8 * 16
  });

  it("flags an active source that went silent", async () => {
    expect(await check(`source.${source.id}`, at("10:00:00"))).toBeUndefined(); // never pushed
    await db.query(`update sources set last_seen = $1`, [at("09:50:00")]);
    expect((await check(`source.${source.id}`, at("10:00:00")))?.ok).toBe(true);
    expect((await check(`source.${source.id}`, at("10:31:00")))?.ok).toBe(false);
    await db.query(`update sources set status = 'paused'`);
    expect(await check(`source.${source.id}`, at("10:31:00"))).toBeUndefined();
    await db.query(`update sources set status = 'active'`);
  });

  it("flags a raw inbox that is not being flushed", async () => {
    await db.query(`insert into raw_inbox (source_id, tenant_id, received_at, body) values ($1, $2, $3, '{}')`, [
      source.id, ORG, at("07:00:00"),
    ]);
    expect((await check("raw.inbox", at("08:00:00")))?.ok).toBe(true);
    expect((await check("raw.inbox", at("09:01:00")))?.ok).toBe(false);
  });
});

describe("notices", () => {
  const bad = { key: "x", ok: false, message: "x is broken" };
  const good = { ...bad, ok: true };

  it("opens, repeats after alerts.repeat_h, and resolves", async () => {
    expect((await updateNotices(db, [bad], at("10:00:00"))).opened).toHaveLength(1);
    const again = await updateNotices(db, [bad], at("11:00:00"));
    expect(again.opened.length + again.repeated.length).toBe(0);
    await set("alerts.repeat_h", 1);
    expect((await updateNotices(db, [bad], at("12:00:00"))).repeated).toHaveLength(1);
    expect((await updateNotices(db, [good], at("13:00:00"))).resolved).toEqual(["x is broken"]);
    expect((await updateNotices(db, [bad], at("14:00:00"))).opened).toHaveLength(1); // reopens
    await set("alerts.repeat_h", 24);
  });

  it("clears a notice quietly when its check disappears", async () => {
    await updateNotices(db, [bad], at("10:00:00"));
    expect((await updateNotices(db, [], at("11:00:00"))).resolved).toEqual([]);
    const { rows } = await db.query(`select resolved_at from engine_notices where key = 'x'`);
    expect(rows[0].resolved_at).not.toBeNull();
  });

  it("mails the platform admins, or alerts.email_to when set", async () => {
    expect(await alertRecipients(db)).toEqual(["admin@x.it"]);
    await set("alerts.email_to", ["ops@x.it"]);
    expect(await alertRecipients(db)).toEqual(["ops@x.it"]);
    await set("alerts.email_to", []);
  });
});

describe("runHealth", () => {
  it("mails new problems once and records the run", async () => {
    await set("quota.db_bytes", 1000);
    const mailer = new FakeMailer();
    const r = await runHealth(db, { mailer, now: at("10:00:00") });
    expect(r.mailed).toBe(1);
    expect(mailer.sent[0].to).toEqual(["admin@x.it"]);
    expect(mailer.sent[0].subject).toContain("db_bytes");
    await runHealth(db, { mailer, now: at("11:00:00") });
    expect(mailer.sent).toHaveLength(1);
    const { rows } = await db.query(`select last_ok, last_error, last_result from engine_jobs where name = 'health'`);
    expect(rows[0].last_error).toBeNull();
    expect(rows[0].last_result.ok).toBe(false);
  });

  it("keeps a problem due when the mail fails", async () => {
    await set("quota.db_bytes", 1000);
    const mailer = new FakeMailer();
    mailer.fail = true;
    await expect(runHealth(db, { mailer, now: at("10:00:00") })).rejects.toThrow("smtp down");
    const { rows } = await db.query(`select last_sent from engine_notices where key = 'quota.db_bytes'`);
    expect(rows[0].last_sent).toBeNull();
    const job = await db.query(`select last_error from engine_jobs where name = 'health'`);
    expect(job.rows[0].last_error).toBe("smtp down");
    mailer.fail = false;
    expect((await runHealth(db, { mailer, now: at("10:05:00") })).changes.repeated).toHaveLength(1);
  });
});

describe("usage metering", () => {
  it("counts store operations into this month's usage", async () => {
    const store = new MeteredStore(new MemoryStore());
    await store.putNew("a", new Uint8Array(1), "x");
    await store.list("");
    await store.get("a");
    expect(store.ops).toEqual({ writes: 2, reads: 1 });
    await recordUsage(db, store.ops, at("10:00:00"));
    await recordUsage(db, store.ops, at("11:00:00"));
    await recordUsage(db, { writes: 7, reads: 0 }, new Date("2026-11-01T00:00:00Z"));
    expect(await monthUsage(db, at("12:00:00"))).toEqual({ "r2.writes": 4, "r2.reads": 2 });
    expect(await monthUsage(db, new Date("2026-11-02T00:00:00Z"))).toEqual({ "r2.writes": 7 });
  });
});

describe("sources", () => {
  it("rotates a token: the old one stops working", async () => {
    const { source: s, token: old } = await createSource(db, { tenantId: ORG, name: "rot", module: "testmod" });
    const token = await rotateToken(db, s.id);
    expect(await sourceByToken(db, old)).toBeNull();
    expect((await sourceByToken(db, token))?.id).toBe(s.id);
    const { rows } = await db.query(`select token_hash, token_hint from sources where id = $1`, [s.id]);
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect(token.endsWith(rows[0].token_hint)).toBe(true);
  });
});

describe("ResendMailer", () => {
  it("posts to the Resend API and throws on errors", async () => {
    const calls: [string, RequestInit][] = [];
    let status = 200;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response("nope", { status });
    }) as unknown as typeof fetch;
    const m = new ResendMailer("key", fake);
    const mail = { from: "a@x", to: ["b@x"], subject: "s", text: "t" };
    await m.send(mail);
    expect(calls[0][0]).toBe("https://api.resend.com/emails");
    expect((calls[0][1].headers as Record<string, string>).authorization).toBe("Bearer key");
    expect(JSON.parse(String(calls[0][1].body))).toEqual(mail);
    status = 422;
    await expect(m.send(mail)).rejects.toThrow("422");
  });
});
