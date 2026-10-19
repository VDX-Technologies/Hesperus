// Upload connector: a CSV is stored once with a documents row, its rows go through the push
// path with the source's column mapping, and the limits, duplicates and bad rows are reported.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import { createSource, type Source } from "../../lib/engine/sources";
import { MemoryStore } from "../../lib/engine/store";
import { ConnectorError } from "../../lib/engine/connectors";
import { parseCsv } from "../../lib/engine/csv";
import * as XLSX from "xlsx";
import { getSettings } from "../../lib/engine/settings";
import { decodeText, ingestUpload, listUploads, saveUploadConfig, uploadSources } from "../../lib/engine/upload";
import { parseDate, parseNumber, recordsPackage } from "../../lib/packages/records";

vi.mock("server-only", () => ({}));
const { listEntries } = await import("../../lib/packages/records/console");

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const USER = { id: "00000000-0000-0000-0000-000000000001", email: "owner@example.com" };
const store = new MemoryStore();
const now = new Date("2026-10-18T10:00:00Z");
const enc = (s: string) => new TextEncoder().encode(s);
let harvest: Source, treatments: Source;

const reload = async (id: string) =>
  (await db.query<Source>(`select id, tenant_id, name, connector, module, config, status from sources where id = $1`, [id])).rows[0];

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  A = forTenant(db, ORG);
  ({ source: harvest } = await createSource(db, {
    tenantId: ORG, name: "Raccolta", module: "records", connector: "upload", config: { mapping: {}, fixed: { kind: "harvest" } },
  }));
  ({ source: treatments } = await createSource(db, {
    tenantId: ORG, name: "Trattamenti", module: "records", connector: "upload", config: { mapping: {}, fixed: { kind: "treatment" } },
  }));
  await getSettings(db, true);
});
afterAll(async () => drop?.());

describe("csv and value parsing", () => {
  it("reads quoted fields, semicolons, BOM and blank lines", () => {
    const c = parseCsv('﻿a;b;c\r\n1;"x;y";"he said ""hi"""\r\n\r\n2;;\n');
    expect(c.delimiter).toBe(";");
    expect(c.headers).toEqual(["a", "b", "c"]);
    expect(c.rows).toEqual([["1", "x;y", 'he said "hi"'], ["2", "", ""]]);
    expect(parseCsv("a\tb\n1\t2").rows).toEqual([["1", "2"]]);
    expect(() => parseCsv('a,b\n"open,1')).toThrow(SyntaxError);
    expect(() => parseCsv("a\n1\n2\n3", 2)).toThrow(RangeError);
  });

  it("parses european dates and numbers", () => {
    expect(parseDate("03/09/2026").toISOString()).toBe("2026-09-03T12:00:00.000Z");
    expect(parseDate("3.9.26 07:30").toISOString()).toBe("2026-09-03T07:30:00.000Z");
    expect(parseDate("2026-09-03").getUTCDate()).toBe(3);
    expect(() => parseDate("31/02/2026")).toThrow();
    expect(() => parseDate("ieri")).toThrow();
    expect(parseNumber("1.234,5", "q")).toBe(1234.5);
    expect(parseNumber("1,234.5", "q")).toBe(1234.5);
    expect(parseNumber("0,75", "q")).toBe(0.75);
    expect(parseNumber("", "q")).toBeUndefined();
    expect(() => parseNumber("tanti", "q")).toThrow();
  });

  it("decodes UTF-8 and falls back to Windows-1252", () => {
    expect(decodeText(enc("Qualità"))).toBe("Qualità");
    expect(decodeText(new Uint8Array([0x51, 0x75, 0x61, 0x6c, 0x69, 0x74, 0xe0]))).toBe("Qualità");
  });
});

describe("upload", () => {
  it("loads a harvest register (semicolons, dd/mm/yyyy) and records the file", async () => {
    await saveUploadConfig(A, harvest.id, { mapping: { Data: "date", Appezzamento: "subject", "Kg raccolti": "quantity", Note: "note", Extra: "" } }, USER);
    harvest = await reload(harvest.id);
    expect(harvest.config).toEqual({ mapping: { Data: "date", Appezzamento: "subject", "Kg raccolti": "quantity", Note: "note" }, fixed: { kind: "harvest" } });

    const csv = "Data;Appezzamento;Kg raccolti;Note;Extra\n01/09/2026;Vigna nord;1.250,5;prima passata;x\n02/09/2026;Vigna sud;980;;\n03/09/2026;Vigna nord;1100;;\n";
    const r = await ingestUpload(db, store, harvest, { name: "raccolta 2026.csv", type: "text/csv", bytes: enc(csv) }, recordsPackage, USER, now);
    expect(r).toMatchObject({ rows: 3, accepted: 3, rejected: [], metrics: 3, events: 3 });

    const doc = (await db.query(`select * from documents where id = $1`, [r.documentId])).rows[0];
    expect(doc).toMatchObject({ tenant_id: ORG, source_id: harvest.id, filename: "raccolta 2026.csv", size: String(csv.length) });
    expect(doc.storage_key).toMatch(new RegExp(`^docs/${ORG}/${harvest.id}/[0-9a-f]{64}-raccolta_2026\\.csv$`));
    expect(store.objects.has(doc.storage_key)).toBe(true);
    const linked = await db.query(`select count(*)::int n from document_objects where document_id = $1`, [r.documentId]);
    expect(linked.rows[0].n).toBe(2); // two subjects

    const entries = await listEntries(A);
    expect(entries).toHaveLength(3);
    const first = entries.find((e) => e.payload.date === "2026-09-01T12:00:00.000Z")!;
    expect(first).toMatchObject({ subject: "Vigna nord", payload: { kind: "harvest", quantity: 1250.5, note: "prima passata" } });
    expect(first.payload).not.toHaveProperty("Extra");

    const audit = await db.query(`select action, subject, actor_label from audit_log where tenant_id = $1 order by id`, [ORG]);
    expect(audit.rows.map((x) => [x.action, x.subject])).toEqual([["upload.mapping", "Raccolta"], ["upload.file", "raccolta 2026.csv"]]);
    expect(audit.rows[1].actor_label).toBe(USER.email);

    const [up] = await listUploads(A);
    expect(up).toMatchObject({ filename: "raccolta 2026.csv", source: "Raccolta", rows: 3, accepted: 3, rejectedCount: 0 });
  });

  it("loads a treatment register and reports bad rows by file line", async () => {
    await saveUploadConfig(A, treatments.id, {
      mapping: { data: "date", campo: "subject", prodotto: "product", "dose (l/ha)": "dose", "superficie ha": "area", operatore: "operator" },
    }, USER);
    treatments = await reload(treatments.id);
    const csv = [
      "data,campo,prodotto,dose (l/ha),superficie ha,operatore",
      "05/09/2026,Vigna nord,Rame,\"2,5\",\"1,2\",Mario",
      "06/09/2026,,Zolfo,3,1,Mario", // line 3: no subject
      "31/09/2026,Vigna sud,Zolfo,3,1,Anna", // line 4: no such date
      "07/09/2026,Vigna sud,Zolfo,tre,1,Anna", // line 5: bad number
      "08/09/2026,Vigna sud,Zolfo,3,\"0,8\",Anna",
    ].join("\n");
    const r = await ingestUpload(db, store, treatments, { name: "trattamenti.csv", bytes: enc(csv) }, recordsPackage, USER, new Date(now.getTime() + 60e3));
    expect(r.rows).toBe(5);
    expect(r.accepted).toBe(2);
    expect(r.rejected.map((x) => x.line)).toEqual([3, 4, 5]);
    expect(r.rejected[0].error).toMatch(/subject/);

    const rame = (await listEntries(A)).find((e) => e.payload.product === "Rame")!;
    expect(rame.payload).toMatchObject({ kind: "treatment", dose: 2.5, area: 1.2, operator: "Mario", subject: "Vigna nord" });
    const [up] = await listUploads(A);
    expect(up).toMatchObject({ rejectedCount: 3, rejected: [{ line: 3 }, { line: 4 }, { line: 5 }] });
    const src = await db.query(`select last_error from sources where id = $1`, [treatments.id]);
    expect(src.rows[0].last_error).toMatch(/rejected/);
  });

  it("refuses duplicates, oversized files, unmapped files and the daily limit", async () => {
    const status = (p: Promise<unknown>) => p.then(() => 0, (e) => (e instanceof ConnectorError ? e.status : -1));
    const csv = "Data;Appezzamento;Kg raccolti\n04/09/2026;Vigna sud;700\n";
    await ingestUpload(db, store, harvest, { name: "a.csv", bytes: enc(csv) }, recordsPackage, USER, now);
    expect(await status(ingestUpload(db, store, harvest, { name: "a-again.csv", bytes: enc(csv) }, recordsPackage, USER, now))).toBe(409);
    expect(await status(ingestUpload(db, store, harvest, { name: "e.csv", bytes: new Uint8Array() }, recordsPackage, USER, now))).toBe(400);
    expect(await status(ingestUpload(db, store, harvest, { name: "u.csv", bytes: enc("x;y\n1;2\n") }, recordsPackage, USER, now))).toBe(422);
    expect(await status(ingestUpload(db, store, harvest, { name: "q.csv", bytes: enc('a;b\n"1;2\n') }, recordsPackage, USER, now))).toBe(400);
    const push = (await createSource(db, { tenantId: ORG, name: "gw", module: "records" })).source;
    expect(await status(ingestUpload(db, store, push, { name: "p.csv", bytes: enc(csv) }, recordsPackage, USER, now))).toBe(403);

    await db.query(`update engine_settings set value = '40' where key = 'upload.max_bytes'`);
    await db.query(`update engine_settings set value = '1' where key = 'upload.max_rows'`);
    await getSettings(db, true);
    expect(await status(ingestUpload(db, store, harvest, { name: "big.csv", bytes: enc(csv + "x".repeat(40)) }, recordsPackage, USER, now))).toBe(413);
    expect(await status(ingestUpload(db, store, harvest, { name: "rows.csv", bytes: enc("Data;Appezzamento\n1/9/26;a\n2/9/26;b\n") }, recordsPackage, USER, now))).toBe(413);

    await db.query(`update engine_settings set value = '2' where key = 'upload.files_per_day'`);
    await getSettings(db, true);
    expect(await status(ingestUpload(db, store, harvest, { name: "d.csv", bytes: enc("Data;Appezzamento\n1/9/26;c\n") }, recordsPackage, USER, now))).toBe(429);
    // a day later the quota is free again
    const later = new Date(now.getTime() + 25 * 3600e3);
    expect(await status(ingestUpload(db, store, harvest, { name: "d.csv", bytes: enc("Data;Appezzamento\n1/9/26;c\n") }, recordsPackage, USER, later))).toBe(0);

    // nothing was stored for the refused files
    const docs = await db.query(`select filename from documents where source_id = $1 order by created_at`, [harvest.id]);
    expect(docs.rows.map((d) => d.filename)).toEqual(["raccolta 2026.csv", "a.csv", "d.csv"]);
    await db.query(`update engine_settings set value = d.v::jsonb from (values ('upload.max_bytes', '5242880'), ('upload.max_rows', '5000'), ('upload.files_per_day', '50')) d(k, v) where key = d.k`);
    await getSettings(db, true);
  });

  it("keeps each tenant to its own sources", async () => {
    const B = forTenant(db, OTHER);
    expect(await uploadSources(B)).toEqual([]);
    expect(await listUploads(B)).toEqual([]);
    await expect(saveUploadConfig(B, harvest.id, { mapping: { a: "date" } }, USER)).rejects.toMatchObject({ status: 404 });
    expect((await uploadSources(A)).map((s) => s.name)).toEqual(["Raccolta", "Trattamenti"]);
  });
});

describe("any file", () => {
  it("loads a spreadsheet through the mapping, and keeps a file with no table as a document with its text", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ["Trattamenti ottobre"],
      ["data", "campo", "prodotto", "dose (l/ha)", "superficie ha", "operatore"],
      ["12/10/2026", "Uliveto", "Rame", 2, 1.5, "Anna"],
    ]), "Foglio1");
    const later = new Date(now.getTime() + 3600e3);
    const r = await ingestUpload(db, store, treatments, { name: "ottobre.xlsx", bytes: new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })) }, recordsPackage, USER, later);
    expect(r).toMatchObject({ table: true, rows: 1, accepted: 1 });
    expect((await listEntries(A)).find((e) => e.subject === "Uliveto")?.payload).toMatchObject({ product: "Rame", dose: 2, area: 1.5 });

    const memo = await ingestUpload(db, store, treatments, { name: "verbale.txt", bytes: enc("Verbale del sopralluogo in vigna.\nTutto regolare.\n") }, recordsPackage, USER, later);
    expect(memo).toMatchObject({ table: false, rows: 0, accepted: 0 });
    const doc = (await db.query(`select text_content, metadata from documents where id = $1`, [memo.documentId])).rows[0];
    expect(doc.text_content).toContain("sopralluogo");
    expect(doc.metadata).toMatchObject({ format: "text", table: false });
    expect((await listUploads(A)).find((u) => u.id === memo.documentId)).toMatchObject({ table: false });
  });
});
