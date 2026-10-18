// The treatment form: the event's own fields plus the day it was done (the event time).
// Shared by the browser form and the server action, so no server imports.
import type { Schema } from "../../engine/schema";
import { TREATMENT_FIELDS } from "./index";

export const TREATMENT_FORM: Schema = {
  date: { type: "timestamp", required: true, label: { en: "Date", it: "Data" } },
  ...TREATMENT_FIELDS,
};

/** Field order of the form, as on the paper register (crop is chosen above). */
export const TREATMENT_ORDER = ["area_ha", "phase", "adversity", "product", "quantity", "date", "operator", "notes"];


const dec = (v: unknown) => (typeof v === "number" ? String(v).replace(".", ",") : "");

/** A recorded treatment back into form text, for "Repeat last" and corrections. */
export function treatmentValues(e: { ts: Date; payload: Record<string, unknown>; objectIds: string[] }, crop?: string): Record<string, string> {
  const p = e.payload;
  const q = p.quantity as { value?: number; unit?: string } | undefined;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    crop: crop ?? e.objectIds[0] ?? "",
    date: e.ts.toISOString().slice(0, 10),
    area_ha: dec(p.area_ha),
    phase: s(p.phase),
    adversity: s(p.adversity),
    product: s(p.product),
    quantity: dec(q?.value),
    "quantity.unit": q?.unit ?? "",
    operator: s(p.operator),
    notes: s(p.notes),
  };
}
