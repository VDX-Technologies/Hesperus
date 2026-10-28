import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
vi.mock("server-only", () => ({}));
import { PDFDocument } from "pdf-lib";
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import { createManualObject, recordEvent, type Author } from "../../lib/engine/manual";
import { allEvents, cursorOf, listEvents, parseCursor } from "../../lib/engine/events";
import { listAudit } from "../../lib/engine/audit";
import { tablePdf } from "../../lib/engine/pdf";
import {
  csvHeader, csvLine, filtersFrom, getEventType, listEventTypes, registerQuery, saveEventType, specOf, subjectObjects,
} from "../../lib/engine/registers";
import { agronomyPackage } from "../../lib/packages/agronomy";

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb, B: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const owner: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "o@x.it", role: "owner" };
const member: Author = { id: "00000000-0000-0000-0000-0000000000f2", email: "m@x.it", role: "member" };
const pkgs = [agronomyPackage];
let vine: string, olive: string;

const pruning = {
  key: "pruning",
  name: { it: "Potatura", en: "Pruning" },
  subject: "agronomy.crop",
  fields: {
    method: { type: "string" as const, required: true, enum: ["verde", "secco"] },
    plants: { type: "integer" as const, min: 0 },
    hours: { type: "quantity" as const, units: ["h"] },
    species: { type: "string" as const },
  },
  fromSubject: { species: "species" },
};

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  A = forTenant(db, ORG);
  B = forTenant(db, OTHER);
  vine = await createManualObject(A, agronomyPackage, owner, { type: "crop", name: "Vigna", properties: { species: "Vite", hectares: 2, phase: "fioritura" } });
  olive = await createManualObject(A, agronomyPackage, owner, { type: "crop", name: "Oliveto", properties: { species: "Olivo", hectares: 1, phase: "crescita" } });
});
afterAll(async () => drop?.());

describe("custom event types", () => {
  it("only the owner saves a type; bad definitions are refused; audited", async () => {
    await expect(saveEventType(A, member, pruning)).rejects.toMatchObject({ status: 403 });
    await expect(saveEventType(A, owner, { ...pruning, key: "Bad key" })).rejects.toMatchObject({ status: 400 });
    await expect(saveEventType(A, owner, { ...pruning, fields: { q: { type: "quantity" } } })).rejects.toMatchObject({ status: 400 });
    expect(await saveEventType(A, owner, pruning)).toBe("custom.pruning");
    const types = await listEventTypes(A, pkgs);
    expect(types.map((t) => t.type).filter((t) => t.startsWith("custom."))).toEqual(["custom.pruning"]);
    expect(types.at(-1)!.custom).toBe(true);
    expect(Object.keys(types.at(-1)!.fields)).toEqual(["method", "plants", "hours", "species"]);
    expect(types.at(-1)).toMatchObject({ custom: true, subject: "agronomy.crop", fromSubject: { species: "species" } });
    expect(await getEventType(B, pkgs, "custom.pruning")).toBeNull();
    expect((await listAudit(A, { limit: 10 })).some((e) => e.action === "event_type.create")).toBe(true);
  });

  it("records at once, checked against the type and its subject", async () => {
    const t = (await getEventType(A, pkgs, "custom.pruning"))!;
    const spec = specOf(t, pkgs);
    for (let i = 0; i < 25; i++)
      await recordEvent(A, spec, member, {
        ts: new Date(Date.UTC(2026, 9, 1 + (i % 10))), payload: { method: i % 2 ? "secco" : "verde", plants: i, hours: { value: 1.5, unit: "h" } }, objectIds: [i % 3 ? vine : olive],
      });
    await expect(recordEvent(A, spec, member, { ts: new Date(), payload: { method: "boh" }, objectIds: [vine] })).rejects.toMatchObject({ status: 400 });
    const place = (await db.query(`select id from objects where tenant_id = $1 and id <> all($2::uuid[]) limit 1`, [ORG, [vine, olive]])).rows[0];
    if (place) await expect(recordEvent(A, spec, member, { ts: new Date(), payload: { method: "verde" }, objectIds: [place.id] })).rejects.toMatchObject({ status: 400 });
    await expect(recordEvent(B, spec, owner, { ts: new Date(), payload: { method: "verde" }, objectIds: [vine] })).rejects.toMatchObject({ status: 404 });
    expect((await subjectObjects(A, "agronomy.crop")).map((o) => o.name)).toEqual(["Oliveto", "Vigna"]);
  });

  it("filters from the query string, applied by the database", async () => {
    const t = (await getEventType(A, pkgs, "custom.pruning"))!;
    const f = filtersFrom(t, { "f.method": "secco", "f.plants": "3", from: "2026-10-01", to: "2026-10-10", obj: vine, "f.nope": "x" });
    expect(f.fields).toEqual({ method: "secco", plants: "3" });
    expect(await listEvents(A, registerQuery(t, f))).toHaveLength(0);
    const secco = await listEvents(A, registerQuery(t, filtersFrom(t, { "f.method": "secco" })));
    expect(secco).toHaveLength(12);
    expect(await listEvents(A, registerQuery(t, filtersFrom(t, { from: "2026-10-02", to: "2026-10-02" })))).toHaveLength(3);
  });
});

describe("keyset paging and chunked exports", () => {
  it("pages walk every event once, newest first, with ties on ts", async () => {
    const t = (await getEventType(A, pkgs, "custom.pruning"))!;
    const q = registerQuery(t, filtersFrom(t, {}));
    const seen: number[] = [];
    let after = undefined as ReturnType<typeof parseCursor>;
    for (let page = 0; page < 10; page++) {
      const rows = await listEvents(A, { ...q, after, limit: 7 });
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 7) break;
      after = parseCursor(cursorOf(rows[rows.length - 1]));
    }
    const all = await listEvents(A, { ...q, limit: 100 });
    expect(seen).toEqual(all.map((r) => r.id));
    expect(new Set(seen).size).toBe(25);
    expect(parseCursor("garbage")).toBeUndefined();
  });

  it("allEvents reads in chunks, oldest first", async () => {
    const t = (await getEventType(A, pkgs, "custom.pruning"))!;
    const rows = [];
    for await (const e of allEvents(A, { ...registerQuery(t, filtersFrom(t, {})), asc: true }, 4)) rows.push(e);
    expect(rows).toHaveLength(25);
    expect(rows.map((r) => r.ts.getTime())).toEqual([...rows.map((r) => r.ts.getTime())].sort((a, b) => a - b));
  });

  it("CSV lines with keys, comma decimals, quantity in two columns; PDF over pages", async () => {
    const t = (await getEventType(A, pkgs, "custom.pruning"))!;
    const names = new Map([[vine, "Vigna"], [olive, "Oliveto"]]);
    expect(csvHeader(t)).toBe("﻿date;object;method;plants;hours;hours_unit;species;recorded_by;recorded_at;version;id\r\n");
    const e = (await listEvents(A, { types: [t.type], limit: 1 }))[0];
    expect(csvLine(t, e, names)).toMatch(/^2026-10-\d\d;(Vigna|Oliveto);(verde|secco);\d+;1,5;h;;m@x\.it;/);
    async function* cells() {
      for await (const r of allEvents(A, { types: [t.type], asc: true }, 5)) for (let k = 0; k < 4; k++) yield [r.ts.toISOString(), names.get(r.objectIds[0])!, String(r.payload.method)];
    }
    const pdf = await tablePdf({ title: "Potatura", subtitle: "A", columns: [{ label: "Data", width: 1 }, { label: "Coltura", width: 2 }, { label: "Metodo", width: 1 }], rows: cells(), empty: "-" });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1);
  });
});
