import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
vi.mock("server-only", () => ({}));
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import type { Author } from "../../lib/engine/manual";
import { createSource } from "../../lib/engine/sources";
import { MemoryStore } from "../../lib/engine/store";
import { countLinked, createObject, getObject, getObjectType, objectDocuments, objectHistogram, objectPoints, searchObjects, updateObject } from "../../lib/engine/custom-objects";
import { pushDocument } from "../../lib/engine/custom-ingest";
import { listAudit } from "../../lib/engine/audit";
import { getSettings } from "../../lib/engine/settings";
import { batchPatch, filterQuery, inlineImage, lastVisit, projectFields, resultFilters, resultsCsv, reviewPatch, RESEARCH, shownColumns, viewQuery } from "../../lib/research";
import { seedResearch } from "../../scripts/research/types";

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb, B: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const owner: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "o@x.it", role: "owner" };
let tess: string, other: string, otherB: string;
const ids: Record<string, string> = {};

const result = (t: TenantDb, project: string, name: string, score: number, review = "to_review") =>
  createObject(t, owner, { type: RESEARCH.result, name, externalId: name, links: { project }, properties: { score, review, extra: { tic_id: 1 } } });

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  A = forTenant(db, ORG);
  B = forTenant(db, OTHER);
  await seedResearch(A, owner);
  await seedResearch(B, { ...owner, id: "00000000-0000-0000-0000-0000000000f3" });
  const project = (t: TenantDb, name: string) => createObject(t, owner, {
    type: RESEARCH.project, name, properties: { area: "astrofisica", stage: "running", result_schema: { tic_id: { type: "integer", required: true } } },
  });
  tess = await project(A, "TESS anomalie");
  other = await project(A, "Altro");
  otherB = await project(B, "TESS di B");
  for (const [n, s, r] of [["a", 0.9, "to_review"], ["b", 0.4, "interesting"], ["c", 0.7, "to_review"], ["d", 0.1, "discarded"]] as const)
    ids[n] = await result(A, tess, n, s, r);
  ids.o = await result(A, other, "o", 0.95);
  ids.x = await result(B, otherB, "x", 0.99);
});
afterAll(async () => drop?.());

describe("research console", () => {
  const names = (r: { objects: { name: string }[] }) => r.objects.map((o) => o.name);

  it("filters a project's results by score and review, highest first, with the total", async () => {
    const all = await searchObjects(A, RESEARCH.result, resultFilters({}, tess));
    expect(names(all)).toEqual(["a", "c", "b", "d"]);
    expect(all.total).toBe(4);
    const some = await searchObjects(A, RESEARCH.result, resultFilters({ min: "0,4", max: "0.8", order: "asc" }, tess));
    expect(names(some)).toEqual(["b", "c"]);
    const pending = await searchObjects(A, RESEARCH.result, resultFilters({ review: "to_review" }, tess));
    expect(names(pending)).toEqual(["a", "c"]);
    expect(pending.total).toBe(2);
  });

  it("pages with a total over every page, and the page size is a setting", async () => {
    const page = await searchObjects(A, RESEARCH.result, { ...resultFilters({}, tess), limit: 2, offset: 2 });
    expect(names(page)).toEqual(["b", "d"]);
    expect(page.total).toBe(4);
    await db.query(`update engine_settings set value = '3' where key = 'objects.page_size'`);
    await getSettings(db, true);
    expect((await searchObjects(A, RESEARCH.result, { linkedTo: { key: "project", id: tess } })).objects).toHaveLength(3);
    await db.query(`update engine_settings set value = '100' where key = 'objects.page_size'`);
    await getSettings(db, true);
  });

  it("ignores keys the type does not declare or cannot compare", async () => {
    const r = await searchObjects(A, RESEARCH.result, { linkedTo: { key: "project", id: tess }, where: { nope: "x", extra: "y" }, min: { review: 1 }, order: { by: "nope" } });
    expect(r.total).toBe(4);
    expect(await searchObjects(A, "custom.nope", {})).toEqual({ objects: [], total: 0 });
  });

  it("never returns another tenant's results", async () => {
    expect((await searchObjects(A, RESEARCH.result, { min: { score: 0.98 } })).total).toBe(0);
    expect(names(await searchObjects(B, RESEARCH.result, {}))).toEqual(["x"]);
    expect(await searchObjects(B, RESEARCH.result, resultFilters({}, tess))).toEqual({ objects: [], total: 0 });
  });

  it("counts results per project and review", async () => {
    const counts = await countLinked(A, RESEARCH.result, RESEARCH.link, RESEARCH.review);
    const n = (id: string, v: string) => counts.find((c) => c.id === id && c.value === v)?.n ?? 0;
    expect([n(tess, "to_review"), n(tess, "interesting"), n(tess, "discarded"), n(other, "to_review")]).toEqual([2, 1, 1, 1]);
    expect(counts.some((c) => c.id === otherB)).toBe(false);
  });

  it("counts only the results created since a moment when asked", async () => {
    expect(await countLinked(A, RESEARCH.result, RESEARCH.link, undefined, new Date(Date.now() + 60_000))).toEqual([]);
    const since = await countLinked(A, RESEARCH.result, RESEARCH.link, undefined, new Date(Date.now() - 3_600_000));
    expect(since.find((c) => c.id === tess)?.n).toBe(4);
  });

  it("spreads a numeric property over bins with the same filters as the table", async () => {
    const h = await objectHistogram(A, RESEARCH.result, RESEARCH.score, resultFilters({}, tess), 3);
    expect([h.min, h.max]).toEqual([0.1, 0.9]);
    expect(h.bins.map((b) => b.n)).toEqual([1, 1, 2]);
    expect(h.bins[2].hi).toBe(0.9);
    const some = await objectHistogram(A, RESEARCH.result, RESEARCH.score, resultFilters({ min: "0.4" }, tess), 2);
    expect(some.bins.map((b) => b.n)).toEqual([1, 2]);
    expect((await objectHistogram(A, RESEARCH.result, RESEARCH.score, resultFilters({}, other))).bins).toEqual([{ lo: 0.95, hi: 0.95, n: 1 }]);
    expect(await objectHistogram(A, RESEARCH.result, RESEARCH.review, resultFilters({}, tess))).toEqual({ min: null, max: null, bins: [] });
    expect((await objectHistogram(B, RESEARCH.result, RESEARCH.score, resultFilters({}, tess))).bins).toEqual([]);
  });

  it("plots two numeric properties, a project's own fields included", async () => {
    const type = (await getObjectType(A, RESEARCH.result))!;
    const c = { result: type.properties, own: projectFields((await getObject(A, tess))!), me: owner.email };
    const p = await objectPoints(A, RESEARCH.result, RESEARCH.score, "extra.tic_id", resultFilters({ max: "0.7" }, tess, c));
    expect(p.total).toBe(3);
    expect(p.points.map((x) => [x.name, x.x, x.y]).sort()).toEqual([["b", 0.4, 1], ["c", 0.7, 1], ["d", 0.1, 1]]);
    expect((await objectPoints(A, RESEARCH.result, RESEARCH.score, RESEARCH.score, resultFilters({}, tess), 2)).points).toHaveLength(2);
    expect(await objectPoints(A, RESEARCH.result, RESEARCH.score, "extra.tic_id", resultFilters({}, tess))).toEqual({ points: [], total: 0 });
  });

  it("lists a result's attachments, only in its tenant", async () => {
    const { source } = await createSource(db, { tenantId: ORG, name: "p", module: "custom", config: { scope: { link: "project", id: tess } } });
    const store = new MemoryStore();
    await pushDocument(db, store, source, { name: "lc.png", type: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]) }, { type: RESEARCH.result, externalId: "a" });
    await pushDocument(db, store, source, { name: "data.csv", type: "text/csv", bytes: new Uint8Array([4, 5]) }, { type: RESEARCH.result, externalId: "a" });
    const docs = await objectDocuments(A, ids.a);
    expect(docs.map((d) => [d.filename, d.contentType, d.size]).sort()).toEqual([["data.csv", "text/csv", 2], ["lc.png", "image/png", 9]]);
    expect(await objectDocuments(B, ids.a)).toEqual([]);
  });

  it("a review changes only what differs, and is audited", async () => {
    const o = (await getObject(A, ids.a))!;
    expect(reviewPatch(o, "to_review", "")).toBeNull();
    const patch = reviewPatch(o, "interesting", "  curva strana  ")!;
    expect(patch).toEqual({ review: "interesting", note: "curva strana" });
    await updateObject(A, owner, ids.a, { properties: patch });
    const after = (await getObject(A, ids.a))!;
    expect(after.properties).toMatchObject({ score: 0.9, review: "interesting", note: "curva strana" });
    expect(reviewPatch(after, "interesting", "curva strana")).toBeNull();
    await updateObject(A, owner, ids.a, { properties: reviewPatch(after, "interesting", "")! });
    expect((await getObject(A, ids.a))!.properties.note).toBeUndefined();
    const audit = await listAudit(A, { objectId: ids.a, limit: 10 });
    const updates = audit.filter((e) => e.action === "object.update");
    expect(updates).toHaveLength(2);
    expect(updates.map((e) => (e.data as { changed: unknown }).changed)).toContainEqual({
      review: { before: "to_review", after: "interesting" }, note: { before: null, after: "curva strana" },
    });
    await expect(updateObject(A, { ...owner, role: "viewer" }, ids.a, { properties: { review: "sent" } })).rejects.toMatchObject({ status: 403 });
    await expect(updateObject(B, owner, ids.a, { properties: { review: "sent" } })).rejects.toMatchObject({ status: 404 });
  });

  it("searches by name, filters and sorts by any field, the project's own ones included", async () => {
    const type = (await getObjectType(A, RESEARCH.result))!;
    const c = { result: type.properties, own: projectFields((await getObject(A, tess))!), me: owner.email };
    const find = async (sp: Record<string, string>) => names(await searchObjects(A, RESEARCH.result, resultFilters(sp, tess, c)));
    await updateObject(A, owner, ids.c, { properties: { extra: { tic_id: 5 } } });
    expect(await find({ q: "C" })).toEqual(["c"]);
    expect(await find({ q: "%" })).toEqual([]);
    expect(await find({ "f.review": "interesting" })).toEqual(["a", "b"]);
    expect(await find({ "f.extra.tic_id": "5" })).toEqual(["c"]);
    expect(await find({ "min.extra.tic_id": "2" })).toEqual(["c"]);
    expect(await find({ "f.extra.tic_id": "cinque" })).toEqual(["a", "c", "b", "d"]);
    expect(await find({ sort: "name", order: "asc" })).toEqual(["a", "b", "c", "d"]);
    expect((await find({ sort: "extra.tic_id" }))[0]).toBe("c");
    const b = (await getObject(A, ids.b))!;
    expect(batchPatch(b, { review: "interesting", assignee: "" })).toBeNull();
    await updateObject(A, owner, ids.b, { properties: batchPatch(b, { assignee: owner.email! })! });
    expect(await find({ mine: "1" })).toEqual(["b"]);
    const assigned = (await getObject(A, ids.b))!;
    expect(batchPatch(assigned, { assignee: owner.email! })).toBeNull();
    expect(batchPatch(assigned, { review: "sent", assignee: "-" })).toEqual({ review: "sent", assignee: null });
    expect(filterQuery({ q: " x ", page: "2", saved: "1", "f.review": "sent", "min.extra.tic_id": "1", "x.y": "z" }).toString())
      .toBe("q=x&f.review=sent&min.extra.tic_id=1");
  });

  it("exports results as CSV with keys, comma decimals and the project's fields", async () => {
    const type = (await getObjectType(A, RESEARCH.result))!;
    const csv = resultsCsv(type.properties, projectFields((await getObject(A, tess))!));
    const header = csv.header.replace("\uFEFF", "").trim().split(";");
    expect(header.slice(0, 3)).toEqual(["id", "external_id", "name"]);
    expect(header).toContain("score");
    expect(header).toContain("extra.tic_id");
    expect(header.at(-1)).toBe("created_at");
    const cells = csv.line((await getObject(A, ids.c))!).trim().split(";");
    expect(cells[header.indexOf("score")]).toBe("0,7");
    expect(cells[header.indexOf("extra.tic_id")]).toBe("5");
    expect(cells[1]).toBe("c");
  });

  it("reads the filters forgivingly and shows only raster images inline", () => {
    const f = resultFilters({ min: "abc", max: "", page: "-3", review: ["a", "b"] }, tess);
    expect(f).toMatchObject({ min: undefined, max: undefined, where: undefined, page: 1, order: { by: "score", desc: true } });
    expect(["image/png", "IMAGE/JPEG; q=1", "image/webp"].map(inlineImage)).toEqual([true, true, true]);
    expect(["image/svg+xml", "text/html", null].map(inlineImage)).toEqual([false, false, false]);
  });

  it("keeps the chosen columns and the charts in a view, and nothing else", () => {
    const all = ["score", "review", "extra.mass"];
    expect([...shownColumns(["review", "extra.mass"], all)]).toEqual(["review", "extra.mass"]);
    expect([...shownColumns("review,nope", all)]).toEqual(["review"]);
    expect([...shownColumns(undefined, all)]).toEqual(all);
    expect([...shownColumns("nope", all)]).toEqual(all);
    expect(filterQuery({ cols: ["score", "review"], q: "kepler" }).get("cols")).toBe("score,review");
    const q = new URLSearchParams(viewQuery("q=kepler&cols=score&cols=review&hist=extra.mass&x=score&y=extra.mass&page=3&saved=1&min.extra.mass=2"));
    expect(Object.fromEntries(q)).toEqual({ q: "kepler", cols: "score,review", hist: "extra.mass", x: "score", y: "extra.mass", "min.extra.mass": "2" });
  });

  it("counts new results from the start of the previous visit, the same for a whole visit", () => {
    const h = 3_600_000, t0 = 1_700_000_000_000;
    expect(lastVisit(undefined, t0)).toEqual({ since: null, next: `|${t0}` });
    expect(lastVisit("garbage", t0)).toEqual({ since: null, next: `|${t0}` });
    expect(lastVisit(`|${t0 + h}`, t0)).toEqual({ since: null, next: `|${t0}` });
    expect(lastVisit(`|${t0}`, t0 + 60_000)).toEqual({ since: null, next: null });
    expect(lastVisit(`|${t0}`, t0 + 24 * h)).toEqual({ since: new Date(t0), next: `${t0}|${t0 + 24 * h}` });
    expect(lastVisit(`${t0}|${t0 + 24 * h}`, t0 + 24 * h + 60_000)).toEqual({ since: new Date(t0), next: null });
  });
});
