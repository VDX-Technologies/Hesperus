// The research pipeline through its source token: the project page shows when it last pushed and
// what went wrong, it reads back its project's reviewed results, and a push that creates a run or
// a high-scoring result tells the project's emails and webhook once.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
vi.mock("server-only", () => ({}));
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import type { Author } from "../../lib/engine/manual";
import type { RawMessage } from "../../lib/engine/connectors";
import type { Mail } from "../../lib/engine/mail";
import { createSource, scopedSources, type Source } from "../../lib/engine/sources";
import { createObject, updateObject } from "../../lib/engine/custom-objects";
import { ingestCustom } from "../../lib/engine/custom-ingest";
import { RESEARCH } from "../../lib/research";
import { newsMail, notifyPush, pipelineResults, pushNews } from "../../lib/research-pipeline";
import { seedResearch } from "../../scripts/research/types";

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const owner: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "o@x.it", role: "owner" };
let tess: string, other: string;
let src: Source;

const res = (externalId: string, score: number, review = "to_review"): RawMessage => ({
  kind: "object", type: RESEARCH.result, externalId, name: externalId.toUpperCase(),
  properties: { score, extra: { tic_id: 1 } }, defaults: { review },
});
const run = (key: string): RawMessage => ({
  kind: "event", type: RESEARCH.run, key, objects: [tess], payload: { commit: "abc", items: 3, outcome: "ok" },
});
const query = (s: string) => new URLSearchParams(s);

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'lab-a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  A = forTenant(db, ORG);
  await seedResearch(A, owner);
  const project = (name: string) => createObject(A, owner, {
    type: RESEARCH.project, name, properties: { area: "astrofisica", stage: "running", result_schema: { tic_id: { type: "integer" } } },
  });
  tess = await project("TESS");
  other = await project("Altro");
  ({ source: src } = await createSource(db, { tenantId: ORG, name: "tess-pipeline", module: "custom", config: { scope: { link: "project", id: tess } } }));
  await createSource(db, { tenantId: ORG, name: "altro", module: "custom", config: { scope: { link: "project", id: other } } });
});
afterAll(async () => drop?.());

describe("research pipeline", () => {
  it("shows the project's sources with their last push and its error", async () => {
    let [s] = await scopedSources(A, tess);
    expect(s).toMatchObject({ name: "tess-pipeline", status: "active", lastSeen: null, lastError: null });
    expect(s.tokenHint).toHaveLength(4);
    const when = new Date("2026-10-01T10:00:00Z");
    const out = await ingestCustom(db, src, [res("a", 0.9), { kind: "object", type: RESEARCH.result, externalId: "bad", properties: {} }], when);
    expect(out.accepted).toBe(1);
    [s] = await scopedSources(A, tess);
    expect(s.lastSeen).toEqual(when);
    expect(s.lastError).toMatch(/^1 rejected: /);
    await ingestCustom(db, src, [res("b", 0.4, "interesting"), res("c", 0.7), res("d", 0.1, "discarded")]);
    [s] = await scopedSources(A, tess);
    expect(s.lastError).toBeNull();
    expect((await scopedSources(A, other)).map((x) => x.name)).toEqual(["altro"]);
    expect(await scopedSources(forTenant(db, OTHER), tess)).toEqual([]);
  });

  it("reads back its project's results with their reviews, filtered and paged", async () => {
    const all = await pipelineResults(db, src, query(""));
    expect(all).toMatchObject({ total: 4, offset: 0, limit: 1000 });
    expect(all.results.map((r) => r.externalId)).toEqual(["a", "c", "b", "d"]);
    expect(Object.keys(all.results[0]).sort()).toEqual(["createdAt", "externalId", "id", "name", "properties"]);
    const mine = all.results.find((r) => r.externalId === "a")!;
    await updateObject(A, owner, mine.id, { properties: { review: "interesting" } });
    const liked = await pipelineResults(db, src, query("review=interesting"));
    expect(liked.results.map((r) => r.externalId).sort()).toEqual(["a", "b"]);
    expect((await pipelineResults(db, src, query("min=0.5&order=asc"))).results.map((r) => r.externalId)).toEqual(["c", "a"]);
    const page = await pipelineResults(db, src, query("offset=1&limit=2&page=9"));
    expect(page).toMatchObject({ total: 4, offset: 1, limit: 2 });
    expect(page.results.map((r) => r.externalId)).toEqual(["c", "b"]);
    expect((await pipelineResults(db, src, query("limit=99999"))).limit).toBe(2000);
    await expect(pipelineResults(db, src, query("offset=-1"))).rejects.toMatchObject({ status: 400 });
    await expect(pipelineResults(db, src, query("limit=1.5"))).rejects.toMatchObject({ status: 400 });
  });

  it("refuses sources that do not work for a research project", async () => {
    const { source: loose } = await createSource(db, { tenantId: ORG, name: "loose", module: "custom" });
    await expect(pipelineResults(db, loose, query(""))).rejects.toMatchObject({ status: 403 });
    const { source: dataset } = await createSource(db, { tenantId: ORG, name: "ds", module: "custom", config: { scope: { link: "project", id: "00000000-0000-0000-0000-000000000999" } } });
    await expect(pipelineResults(db, dataset, query(""))).rejects.toMatchObject({ status: 409 });
    await expect(pipelineResults(db, { ...src, module: "hr" }, query(""))).rejects.toMatchObject({ status: 403 });
  });

  it("finds what a push brought: created runs and results above the threshold", () => {
    const messages = [run("r1"), res("x", 0.95), res("y", 0.5), res("z", 0.99), run("r2")];
    const result = {
      accepted: 5, rejected: [],
      results: [
        { index: 0, id: "1", status: "created" as const }, { index: 1, id: "11", status: "created" as const },
        { index: 2, id: "12", status: "created" as const }, { index: 3, id: "13", status: "created" as const },
        { index: 4, id: "2", status: "duplicate" as const },
      ],
    };
    const news = pushNews(messages, result, 0.9);
    expect(news.runs).toEqual([{ id: "1", key: "r1", outcome: "ok", items: 3 }]);
    expect(news.results.map((r) => [r.externalId, r.score])).toEqual([["z", 0.99], ["x", 0.95]]);
    expect(pushNews(messages, result, null).results).toEqual([]);
    const mail = newsMail("TESS", news, "https://core/x");
    expect(mail.subject).toBe("[VDX Research] TESS: 1 run, 2 high-scoring results");
    expect(mail.text).toContain("Z (z): 0.99");
    expect(mail.text.trim().endsWith("https://core/x")).toBe(true);
  });

  it("mails and posts once per push, never again for the same messages", async () => {
    const mails: Mail[] = [];
    const mailer = { send: async (m: Mail) => void mails.push(m) };
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    const deps = { mailer, origin: "https://core.example.com", fetch };
    const push = async (messages: RawMessage[]) => notifyPush(db, src, messages, await ingestCustom(db, src, messages), deps);

    // nobody to tell yet
    expect(await push([run("k0")])).toEqual({ mailed: 0, webhook: false });
    await updateObject(A, owner, tess, {
      properties: { notify_email: "a@x.it, b@x.it; nope", notify_webhook: "https://hooks.example.com/r", notify_score: 0.8 },
    });
    const batch = [run("k1"), res("n1", 0.85), res("n2", 0.3)];
    expect(await push(batch)).toEqual({ mailed: 2, webhook: true });
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(["a@x.it", "b@x.it"]);
    expect(mails[0].subject).toBe("[VDX Research] TESS: 1 run, 1 high-scoring result");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("https://hooks.example.com/r");
    expect(posts[0].body).toMatchObject({
      project: { id: tess, name: "TESS" }, url: `https://core.example.com/research/o/lab-a/p/${tess}`,
      runs: [{ key: "k1", outcome: "ok" }], results: [{ externalId: "n1", score: 0.85 }],
    });
    // sent again: the run is a duplicate and the results are updates, nothing is new
    expect(await push(batch)).toEqual({ mailed: 0, webhook: false });
    // a low score alone is not news
    expect(await push([res("n3", 0.2)])).toEqual({ mailed: 0, webhook: false });
    expect(mails).toHaveLength(1);
    expect(posts).toHaveLength(1);
  });

  it("never posts to plain http, and reports a failing channel after trying the other", async () => {
    await updateObject(A, owner, tess, { properties: { notify_webhook: "http://hooks.example.com/r" } });
    const posts: string[] = [];
    const ok = (async (url: string) => (posts.push(url), new Response(null, { status: 204 }))) as unknown as typeof fetch;
    const mails: Mail[] = [];
    const sent = await notifyPush(db, src, [run("h1")], await ingestCustom(db, src, [run("h1")]), {
      mailer: { send: async (m) => void mails.push(m) }, origin: "https://core", fetch: ok,
    });
    expect(sent).toEqual({ mailed: 2, webhook: false });
    expect(posts).toEqual([]);

    await updateObject(A, owner, tess, { properties: { notify_webhook: "https://hooks.example.com/r" } });
    const down = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(notifyPush(db, src, [run("h2")], await ingestCustom(db, src, [run("h2")]), {
      mailer: { send: async (m) => void mails.push(m) }, origin: "https://core", fetch: down,
    })).rejects.toThrow(/webhook answered 500/);
    expect(mails).toHaveLength(2);
  });
});
