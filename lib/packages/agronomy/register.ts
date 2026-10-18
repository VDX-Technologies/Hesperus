// The treatments register as the paper one: columns in its order, then the three exports.
// CSV and JSON follow the fields the official register asks for (crop and variety, treated
// area, phenological phase, adversity, commercial product, quantity and unit, date, operator)
// so they can be handed over as they are. No server imports: tests use it directly.
import type { Quantity } from "../../engine/schema";
import { PHASE_LABELS, type Phase } from "./index";

export interface CropInfo {
  id: string;
  name: string;
  species: string;
  variety: string | null;
  hectares: number | null;
  phase: Phase | null;
  placeId: string | null;
  placePath: string[];
}

export interface RegisterRow {
  id: number;
  rootId: number;
  version: number;
  date: string;
  cropId: string | null;
  crop: string;
  species: string;
  variety: string | null;
  place: string;
  areaHa: number | null;
  phase: Phase | null;
  adversity: string;
  product: string;
  quantity: Quantity | null;
  operator: string | null;
  notes: string | null;
  recordedBy: string | null;
  recordedAt: string;
}

export const COLUMNS = ["crop", "areaHa", "phase", "adversity", "product", "quantity", "date", "notes"] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, Record<"en" | "it", string>> = {
  crop: { en: "Crop", it: "Coltura" },
  areaHa: { en: "Area (ha)", it: "Superficie (ha)" },
  phase: { en: "Phase", it: "Fase" },
  adversity: { en: "Pest / disease", it: "Avversità" },
  product: { en: "Product", it: "Prodotto" },
  quantity: { en: "Quantity", it: "Quantità" },
  date: { en: "Date", it: "Data" },
  notes: { en: "Notes / operator", it: "Note / operatore" },
};

type EventLike = { id: number; rootId: number; version: number; ts: Date; objectIds: string[]; payload: Record<string, unknown>; authorLabel: string | null; recordedAt: Date };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function toRegisterRow(e: EventLike, crops: Map<string, CropInfo>): RegisterRow {
  const crop = e.objectIds.map((id) => crops.get(id)).find(Boolean) ?? null;
  const p = e.payload;
  return {
    id: e.id,
    rootId: e.rootId,
    version: e.version,
    date: e.ts.toISOString().slice(0, 10),
    cropId: crop?.id ?? null,
    crop: crop ? [crop.name, crop.variety].filter(Boolean).join(" · ") : "",
    species: crop?.species ?? "",
    variety: crop?.variety ?? null,
    place: crop?.placePath.join(" / ") ?? "",
    areaHa: typeof p.area_ha === "number" ? p.area_ha : null,
    phase: (str(p.phase) as Phase | null) ?? null,
    adversity: str(p.adversity) ?? "",
    product: str(p.product) ?? "",
    quantity: (p.quantity as Quantity | undefined) ?? null,
    operator: str(p.operator),
    notes: str(p.notes),
    recordedBy: e.authorLabel,
    recordedAt: e.recordedAt.toISOString(),
  };
}

const num = (v: number | null, locale: "en" | "it") => (v === null ? "" : v.toLocaleString(locale === "it" ? "it-IT" : "en-GB", { maximumFractionDigits: 3 }));
const day = (iso: string, locale: "en" | "it") => (locale === "it" ? iso.split("-").reverse().join("/") : iso);

/** The text of one cell, as written on paper. */
export function cell(r: RegisterRow, c: Column, locale: "en" | "it"): string {
  switch (c) {
    case "crop": return r.crop;
    case "areaHa": return num(r.areaHa, locale);
    case "phase": return r.phase ? PHASE_LABELS[r.phase]?.[locale] ?? r.phase : "";
    case "adversity": return r.adversity;
    case "product": return r.product;
    case "quantity": return r.quantity ? `${num(r.quantity.value, locale)} ${r.quantity.unit}` : "";
    case "date": return day(r.date, locale);
    case "notes": return [r.notes, r.operator].filter(Boolean).join(" — ");
  }
}

/** Field names of the CSV, one per official requirement; separate columns for value and unit. */
export const CSV_FIELDS = [
  "data", "coltura", "specie", "varieta", "appezzamento", "superficie_ha", "fase_fenologica", "avversita",
  "prodotto_commerciale", "quantita", "unita", "operatore", "note", "registrato_da", "registrato_il", "versione",
] as const;

const csvCell = (v: string) => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Semicolon separated, comma decimals, UTF-8 with BOM: opens as is in a spreadsheet set to Italian. */
export function registerCsv(rows: RegisterRow[]): string {
  const dec = (v: number | null) => (v === null ? "" : String(v).replace(".", ","));
  const lines = rows.map((r) =>
    [
      r.date, r.crop, r.species, r.variety ?? "", r.place, dec(r.areaHa), r.phase ?? "", r.adversity,
      r.product, dec(r.quantity?.value ?? null), r.quantity?.unit ?? "", r.operator ?? "", r.notes ?? "",
      r.recordedBy ?? "", r.recordedAt, String(r.version),
    ].map(csvCell).join(";"),
  );
  return "﻿" + [CSV_FIELDS.join(";"), ...lines].join("\r\n") + "\r\n";
}

export function registerJson(rows: RegisterRow[], meta: { organization: string; from: string | null; to: string | null; generatedAt: Date }) {
  return {
    registro: "trattamenti",
    azienda: meta.organization,
    periodo: { dal: meta.from, al: meta.to },
    generato_il: meta.generatedAt.toISOString(),
    trattamenti: rows.map((r) => ({
      id: r.rootId,
      versione: r.version,
      data: r.date,
      coltura: { nome: r.crop, specie: r.species, varieta: r.variety, appezzamento: r.place },
      superficie_ha: r.areaHa,
      fase_fenologica: r.phase,
      avversita: r.adversity,
      prodotto_commerciale: r.product,
      quantita: r.quantity ? { valore: r.quantity.value, unita: r.quantity.unit } : null,
      operatore: r.operator,
      note: r.notes,
      registrato_da: r.recordedBy,
      registrato_il: r.recordedAt,
    })),
  };
}
