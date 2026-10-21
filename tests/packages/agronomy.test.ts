// Agronomy: crops as manual objects in an area, the treatments register (validation, filters,
// corrections, exports) and the LoRa sensors seen from a crop, all within one tenant.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
vi.mock("server-only", () => ({}));
import { freshDb } from "../db/setup";
import { forTenant, type TenantDb } from "../../lib/engine/db";
import { registerPackage } from "../../lib/engine/ingest";
import { createPlace } from "../../lib/engine/places";
import { getSettings } from "../../lib/engine/settings";
import { archiveManualObject, correctManualEvent, createManualEvent, createManualObject, deleteManualObject, ManualEventError, updateManualObject, type Author } from "../../lib/engine/manual";
import { lastEventBy } from "../../lib/engine/events";
import { listAudit } from "../../lib/engine/audit";
import { payloadFromForm } from "../../lib/engine/schema";
import { agronomyPackage } from "../../lib/packages/agronomy";
import { loraPackage } from "../../lib/packages/lora";
import { TREATMENT_FORM, treatmentValues } from "../../lib/packages/agronomy/form";
import { listCrops, listTreatments, sensorsInPlace, suggestions } from "../../lib/packages/agronomy/console";
import { CSV_FIELDS, registerCsv, registerJson } from "../../lib/packages/agronomy/register";
import { PDFDocument } from "pdf-lib";
import { registerPdf } from "../../lib/packages/agronomy/pdf";

let db: Client;
let drop: () => Promise<void>;
let A: TenantDb, B: TenantDb;
const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER = "00000000-0000-0000-0000-00000000000b";
const owner: Author = { id: "00000000-0000-0000-0000-0000000000f1", email: "o@x.it", role: "owner" };
const member: Author = { id: "00000000-0000-0000-0000-0000000000f2", email: "m@x.it", role: "member" };
const viewer: Author = { id: "00000000-0000-0000-0000-0000000000f3", email: "v@x.it", role: "viewer" };
let area: string, sub: string, tomato: string, lettuce: string;

const crop = { species: "Pomodoro", variety: "Datterino", hectares: 1.5, phase: "fioritura" };
const treatment = (over: Record<string, unknown> = {}) => ({
  area_ha: 1.5, phase: "fioritura", adversity: "Peronospora", product: "Poltiglia bordolese", quantity: { value: 2.5, unit: "kg" }, operator: "Mario", ...over,
});
const day = (s: string) => new Date(`${s}T00:00:00Z`);

beforeAll(async () => {
  ({ db, drop } = await freshDb());
  await db.query(`insert into organizations (id, name, slug) values ($1, 'A', 'a'), ($2, 'B', 'b')`, [ORG, OTHER]);
  A = forTenant(db, ORG);
  B = forTenant(db, OTHER);
  const site = await createPlace(A, { kind: "site", name: "Azienda" });
  area = await createPlace(A, { kind: "area", name: "Serra 1", parentId: site });
  sub = await createPlace(A, { kind: "area", name: "Bancale 3", parentId: area });
});
afterAll(async () => drop?.());

describe("crops", () => {
  it("creates a crop located in an area, audited", async () => {
    tomato = await createManualObject(A, agronomyPackage, member, { type: "crop", name: "Pomodoro serra", properties: crop, placeId: area });
    lettuce = await createManualObject(A, agronomyPackage, owner, { type: "crop", name: "Lattuga", properties: { species: "Lattuga", hectares: 0.4, phase: "crescita" } });
    const crops = await listCrops(A);
    const t = crops.find((c) => c.id === tomato)!;
    expect(t).toMatchObject({ species: "Pomodoro", variety: "Datterino", hectares: 1.5, phase: "fioritura", placeId: area, placePath: ["Azienda", "Serra 1"] });
    expect((await listAudit(A, { limit: 10 })).some((e) => e.action === "object.create" && e.objectId === tomato)).toBe(true);
  });

  it("refuses viewers, bad properties and places of another tenant", async () => {
    await expect(createManualObject(A, agronomyPackage, viewer, { type: "crop", name: "X", properties: crop })).rejects.toMatchObject({ status: 403 });
    await expect(createManualObject(A, agronomyPackage, owner, { type: "crop", name: "X", properties: { ...crop, phase: "boh" } })).rejects.toMatchObject({ status: 400 });
    await expect(createManualObject(A, agronomyPackage, owner, { type: "crop", name: "X", properties: { ...crop, hectares: undefined } })).rejects.toMatchObject({ status: 400 });
    const foreign = await createPlace(B, { kind: "site", name: "Altro" });
    await expect(createManualObject(A, agronomyPackage, owner, { type: "crop", name: "X", properties: crop, placeId: foreign })).rejects.toMatchObject({ status: 404 });
  });
});

describe("treatments register", () => {
  let first: number;
  it("parses the form with comma decimals and requires the unit", () => {
    const ok = payloadFromForm(TREATMENT_FORM, { date: "2026-10-01", area_ha: "1,5", phase: "fioritura", adversity: "Oidio", product: "Zolfo", quantity: "0,75", "quantity.unit": "kg" });
    expect(ok.errors).toEqual({});
    expect(ok.payload).toMatchObject({ area_ha: 1.5, quantity: { value: 0.75, unit: "kg" } });
    const bad = payloadFromForm(TREATMENT_FORM, { date: "2026-10-01", area_ha: "uno", phase: "fioritura", adversity: "Oidio", product: "Zolfo", quantity: "1", "quantity.unit": "" });
    expect(bad.errors).toMatchObject({ area_ha: "notNumber", quantity: "unitRequired" });
  });

  it("records treatments; viewers and wrong payloads are refused", async () => {
    first = await createManualEvent(A, agronomyPackage, member, { type: "treatment", ts: day("2026-10-01"), payload: treatment(), objectIds: [tomato] });
    await createManualEvent(A, agronomyPackage, member, { type: "treatment", ts: day("2026-10-05"), payload: treatment({ adversity: "Oidio", product: "Zolfo bagnabile" }), objectIds: [tomato] });
    await createManualEvent(A, agronomyPackage, owner, { type: "treatment", ts: day("2026-10-10"), payload: treatment({ area_ha: 0.4, phase: "crescita", product: "Zolfo bagnabile", adversity: "Oidio" }), objectIds: [lettuce] });
    await expect(createManualEvent(A, agronomyPackage, viewer, { type: "treatment", ts: day("2026-10-02"), payload: treatment(), objectIds: [tomato] })).rejects.toMatchObject({ status: 403 });
    await expect(createManualEvent(A, agronomyPackage, member, { type: "treatment", ts: day("2026-10-02"), payload: treatment({ quantity: { value: 1, unit: "t" } }), objectIds: [tomato] })).rejects.toBeInstanceOf(ManualEventError);
    await expect(createManualEvent(A, agronomyPackage, member, { type: "spraying", ts: day("2026-10-02"), payload: treatment(), objectIds: [tomato] })).rejects.toMatchObject({ status: 400 });
  });

  it("filters by crop, product, adversity and period (both days included)", async () => {
    expect((await listTreatments(A)).map((r) => r.date)).toEqual(["2026-10-10", "2026-10-05", "2026-10-01"]);
    expect(await listTreatments(A, { cropId: tomato })).toHaveLength(2);
    expect(await listTreatments(A, { product: "Zolfo bagnabile" })).toHaveLength(2);
    expect(await listTreatments(A, { adversity: "Peronospora" })).toHaveLength(1);
    expect((await listTreatments(A, { from: "2026-10-05", to: "2026-10-10" })).map((r) => r.date)).toEqual(["2026-10-10", "2026-10-05"]);
    const row = (await listTreatments(A, { adversity: "Peronospora" }))[0];
    expect(row).toMatchObject({ crop: "Pomodoro serra · Datterino", place: "Azienda / Serra 1", areaHa: 1.5, recordedBy: "m@x.it" });
    expect((await suggestions(A)).product[0]).toBe("Zolfo bagnabile");
  });

  it("repeats the last treatment of the user and corrects as a new version", async () => {
    const last = (await lastEventBy(A, member.id, "agronomy.treatment"))!;
    expect(treatmentValues(last)).toMatchObject({ crop: tomato, product: "Zolfo bagnabile", area_ha: "1,5", quantity: "2,5", "quantity.unit": "kg" });
    const v2 = await correctManualEvent(A, agronomyPackage, owner, first, { ts: day("2026-10-01"), payload: treatment({ quantity: { value: 3, unit: "kg" } }) });
    const rows = await listTreatments(A, { adversity: "Peronospora" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: v2, rootId: first, version: 2, quantity: { value: 3, unit: "kg" } });
    await expect(correctManualEvent(A, agronomyPackage, owner, first, { ts: day("2026-10-01"), payload: treatment() })).rejects.toMatchObject({ status: 409 });
  });

  it("keeps tenants apart", async () => {
    expect(await listTreatments(B)).toEqual([]);
    expect(await listCrops(B)).toEqual([]);
    await expect(createManualEvent(B, agronomyPackage, owner, { type: "treatment", ts: day("2026-10-01"), payload: treatment(), objectIds: [tomato] })).rejects.toMatchObject({ status: 404 });
  });
});

describe("exports", () => {
  it("CSV with semicolons, comma decimals and BOM; JSON with the official fields", async () => {
    const rows = await listTreatments(A);
    const csv = registerCsv(rows);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(lines[0]).toBe(CSV_FIELDS.join(";"));
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.includes("Peronospora"))).toContain(";1,5;fioritura;Peronospora;Poltiglia bordolese;3;kg;Mario;");
    const json = registerJson(rows, { organization: "A", from: null, to: null, generatedAt: new Date() });
    expect(json.trattamenti).toHaveLength(3);
    expect(json.trattamenti[2]).toMatchObject({ data: "2026-10-01", versione: 2, quantita: { valore: 3, unita: "kg" }, coltura: { specie: "Pomodoro" } });
  });

  it("PDF over several pages, any character", async () => {
    const rows = await listTreatments(A);
    const many = Array.from({ length: 80 }, (_, i) => ({ ...rows[i % rows.length], id: i, notes: i === 0 ? "Note con emoji 🌱 e ✓" : "Nota lunga ".repeat(i % 5) }));
    const pdf = await registerPdf(many, { organization: "Azienda Agricola Rossi", period: "01/10/2026 – 10/10/2026", locale: "it" });
    expect(Buffer.from(pdf).toString("latin1").startsWith("%PDF")).toBe(true);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1);
    expect((await registerPdf([], { organization: "A", period: "-", locale: "en" })).length).toBeGreaterThan(500);
  });
});

describe("sensors and limits", () => {
  it("finds LoRa sensors in the crop's area and below it", async () => {
    await registerPackage(db, loraPackage);
    const type = (await db.query(`select id from object_types where module = 'lora' and tenant_id is null limit 1`)).rows[0].id;
    const s = (await db.query(`insert into objects (tenant_id, type_id, external_id, name) values ($1, $2, 's1', 'LoRa bancale') returning id`, [ORG, type])).rows[0].id;
    await db.query(`insert into links (tenant_id, type, src_id, dst_id) values ($1, 'located_in', $2, $3)`, [ORG, s, sub]);
    expect(await sensorsInPlace(A, area)).toEqual([{ id: s, name: "LoRa bancale" }]);
    expect(await sensorsInPlace(A, null)).toEqual([]);
    expect(await sensorsInPlace(B, area)).toEqual([]);
  });

  it("stops at manual.objects_max", async () => {
    await db.query(`update engine_settings set value = to_jsonb(2) where key = 'manual.objects_max'`);
    await getSettings(db, true);
    await expect(createManualObject(A, agronomyPackage, owner, { type: "crop", name: "Terza", properties: crop })).rejects.toMatchObject({ status: 429 });
    await createManualObject(B, agronomyPackage, owner, { type: "crop", name: "Prima di B", properties: crop });
    await db.query(`update engine_settings set value = to_jsonb(500) where key = 'manual.objects_max'`);
    await getSettings(db, true);
  });
});

describe("crop lifecycle", () => {
  it("updates the properties keeping status; viewers refused; audited", async () => {
    await expect(updateManualObject(A, agronomyPackage, viewer, lettuce, { species: "Lattuga", hectares: 0.5 })).rejects.toMatchObject({ status: 403 });
    await updateManualObject(A, agronomyPackage, member, lettuce, { species: "Lattuga", hectares: 0.5, phase: "raccolta", status: "archived" });
    const l = (await listCrops(A)).find((c) => c.id === lettuce)!;
    expect(l).toMatchObject({ hectares: 0.5, phase: "raccolta", archived: false });
    const a = (await listAudit(A, { limit: 20 })).find((e) => e.action === "object.update" && e.objectId === lettuce)!;
    expect(a.data).toMatchObject({ before: { hectares: 0.4 }, properties: { hectares: 0.5 } });
  });

  it("archives with an end day; the treatments stay, new ones are refused", async () => {
    const before = await listTreatments(A, { cropId: lettuce });
    await archiveManualObject(A, agronomyPackage, owner, lettuce, day("2026-10-15"));
    await expect(archiveManualObject(A, agronomyPackage, owner, lettuce)).rejects.toMatchObject({ status: 409 });
    expect((await listCrops(A)).find((c) => c.id === lettuce)).toMatchObject({ archived: true, end: "2026-10-15T00:00:00.000Z" });
    expect(await listTreatments(A, { cropId: lettuce })).toEqual(before);
    await expect(createManualEvent(A, agronomyPackage, owner, { type: "treatment", ts: day("2026-10-16"), payload: treatment(), objectIds: [lettuce] })).rejects.toMatchObject({ status: 409 });
    expect((await listAudit(A, { limit: 20 })).some((e) => e.action === "object.archive" && e.objectId === lettuce)).toBe(true);
  });

  it("deletes only crops without events", async () => {
    await expect(deleteManualObject(A, agronomyPackage, owner, tomato)).rejects.toMatchObject({ status: 409 });
    const empty = await createManualObject(A, agronomyPackage, owner, { type: "crop", name: "Vuota", properties: crop, placeId: area });
    await expect(deleteManualObject(A, agronomyPackage, viewer, empty)).rejects.toMatchObject({ status: 403 });
    await expect(deleteManualObject(B, agronomyPackage, owner, empty)).rejects.toMatchObject({ status: 404 });
    await deleteManualObject(A, agronomyPackage, owner, empty);
    expect((await listCrops(A)).some((c) => c.id === empty)).toBe(false);
    expect((await listAudit(A, { limit: 20 })).some((e) => e.action === "object.delete" && e.objectId === empty)).toBe(true);
  });
});
