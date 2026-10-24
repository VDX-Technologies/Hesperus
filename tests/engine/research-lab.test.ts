// What the Research console adds around results: a run and the results it produced, the runs
// that used a dataset, lab notes and threaded comments, a result's outside links, two runs'
// parameters side by side, and the preview of a CSV attachment.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
vi.mock("server-only", () => ({}));
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import type { Author } from "../../lib/engine/manual";
import { createObject, getObject, searchObjects } from "../../lib/engine/custom-objects";
import { getEvent, listEvents } from "../../lib/engine/events";
import { getEventType, specOf } from "../../lib/engine/registers";
import { recordEvent } from "../../lib/engine/manual";
import { commentThreads, csvPreview, expandLinks, paramDiff, RESEARCH } from "../../lib/research";
import { seedResearch } from "../../scripts/research/types";

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb, B: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const owner: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "o@x.it", role: "owner" };
let project: string, dataset: string, result: string;

const record = async (t: TenantDb, type: string, objectIds: string[], payload: Record<string, unknown>, who = owner) =>
  recordEvent(t, specOf((await getEventType(t, [], type))!, []), who, { ts: new Date(), payload, objectIds });

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  A = forTenant(db, ORG);
  B = forTenant(db, OTHER);
  await seedResearch(A, owner);
  await seedResearch(B, { ...owner, id: "00000000-0000-0000-0000-0000000000f3" });
  project = await createObject(A, owner, {
    type: RESEARCH.project, name: "TESS",
    properties: {
      area: "astrofisica", stage: "running", result_schema: { tic_id: { type: "integer" } },
      result_links: "ExoFOP https://exofop.ipac.caltech.edu/tess/target.php?id={tic_id}\nSIMBAD https://simbad.u-strasbg.fr/simbad/sim-id?Ident={name}",
    },
  });
  dataset = await createObject(A, owner, { type: RESEARCH.dataset, name: "Sector 12", properties: { source: "MAST" } });
  result = await createObject(A, owner, {
    type: RESEARCH.result, name: "TIC 1 b", externalId: "r1", links: { project },
    properties: { score: 0.8, review: "to_review", extra: { tic_id: 42 } },
  });
});
afterAll(async () => drop?.());

describe("research lab", () => {
  it("records a run on a project and its datasets, finds its results and the runs of a dataset", async () => {
    const run = await record(A, RESEARCH.run, [project, dataset], { commit: "abc", outcome: "ok", params: { k: 3 } });
    await createObject(A, owner, { type: RESEARCH.result, name: "from run", links: { project }, properties: { score: 0.5, review: "to_review", run } });
    const e = (await getEvent(A, run))!;
    expect([e.type, e.objectIds[0], e.objectIds.slice(1)]).toEqual([RESEARCH.run, project, [dataset]]);
    expect((await searchObjects(A, RESEARCH.result, { where: { [RESEARCH.runRef]: run } })).objects.map((o) => o.name)).toEqual(["from run"]);
    expect((await searchObjects(A, RESEARCH.result, { where: { [RESEARCH.runRef]: run, review: "to_review" }, limit: 0 })).total).toBe(1);
    const used = await listEvents(A, { types: [RESEARCH.run], objectId: dataset, recursive: false });
    expect(used.map((x) => x.id)).toEqual([run]);
    expect(await getEvent(B, run)).toBeNull();
    // a run is about a project; another object type is refused
    await expect(record(A, RESEARCH.run, [dataset], { commit: "x", outcome: "ok" })).rejects.toMatchObject({ status: 400 });
  });

  it("keeps lab notes on the project and comments in threads on the result", async () => {
    await record(A, RESEARCH.labNote, [project], { text: "cambiato il detrender" });
    expect((await listEvents(A, { types: [RESEARCH.labNote], objectId: project, recursive: false })).map((e) => e.payload.text)).toEqual(["cambiato il detrender"]);
    const first = await record(A, RESEARCH.comment, [result], { text: "curva strana" });
    const reply = await record(A, RESEARCH.comment, [result], { text: "sì, guarda il transito 3", reply_to: first });
    await record(A, RESEARCH.comment, [result], { text: "confermo", reply_to: reply });
    await record(A, RESEARCH.comment, [result], { text: "altro" });
    const list = await listEvents(A, { types: [RESEARCH.comment], objectId: result, recursive: false });
    const threads = commentThreads(list);
    expect(threads.map((t) => [t.comment.payload.text, t.replies.map((r) => r.payload.text)])).toEqual([
      ["curva strana", ["sì, guarda il transito 3", "confermo"]],
      ["altro", []],
    ]);
    await expect(record(A, RESEARCH.comment, [result], { text: "no" }, { ...owner, role: "viewer" })).rejects.toMatchObject({ status: 403 });
    await expect(record(A, RESEARCH.comment, [project], { text: "no" })).rejects.toMatchObject({ status: 400 });
  });

  it("fills a result's outside links from the project's template, leaving out the incomplete ones", async () => {
    const o = (await getObject(A, result))!;
    const template = (await getObject(A, project))!.properties[RESEARCH.links];
    expect(expandLinks(template, o)).toEqual([
      { label: "ExoFOP", url: "https://exofop.ipac.caltech.edu/tess/target.php?id=42" },
      { label: "SIMBAD", url: "https://simbad.u-strasbg.fr/simbad/sim-id?Ident=TIC%201%20b" },
    ]);
    expect(expandLinks("A https://x.org/{nope}\nB https://x.org/{external_id}\njavascript:alert(1)\nhttps://y.org/?q={review}", o)).toEqual([
      { label: "B", url: "https://x.org/r1" },
      { label: "y.org", url: "https://y.org/?q=to_review" },
    ]);
    expect(expandLinks(undefined, o)).toEqual([]);
  });

  it("compares two runs' parameters, the differences first", () => {
    expect(paramDiff({ k: 3, model: { depth: 4, lr: 0.1 }, tags: [1] }, { k: 3, model: { depth: 6, lr: 0.1 }, seed: 7 })).toEqual([
      { key: "model.depth", a: 4, b: 6, state: "changed" },
      { key: "seed", a: undefined, b: 7, state: "onlyB" },
      { key: "tags", a: [1], b: undefined, state: "onlyA" },
      { key: "k", a: 3, b: 3, state: "same" },
      { key: "model.lr", a: 0.1, b: 0.1, state: "same" },
    ]);
    expect(paramDiff(undefined, null)).toEqual([]);
  });

  it("previews the first rows of a CSV, cut at a whole line", () => {
    const text = "t;flux\n" + Array.from({ length: 50 }, (_, i) => `${i};1,0${i}`).join("\n");
    const p = csvPreview(new TextEncoder().encode(text), 5)!;
    expect(p.headers).toEqual(["t", "flux"]);
    expect(p.rows).toHaveLength(5);
    expect(p.more).toBe(true);
    const cut = csvPreview(new TextEncoder().encode(text), 100, 30)!;
    expect(cut.rows.every((r) => r.length === 2)).toBe(true);
    expect(cut.more).toBe(true);
    expect(csvPreview(new TextEncoder().encode('a,"b\n1,2'))).toBeNull();
  });
});
