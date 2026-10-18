// Console side of Records: no settings and no rules, a register only stores what happened.
import type { PackageDef } from "../types";

/** Fields a file column can be mapped to, in form order. */
export const RECORD_FIELDS = ["date", "subject", "kind", "quantity", "unit", "product", "dose", "area", "operator", "note"] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];
export const REQUIRED_FIELDS: RecordField[] = ["date", "subject"];

export const records: PackageDef<Record<string, never>> = {
  id: "records",
  name: "Records",
  tagline: { en: "Registers loaded from files", it: "Registri caricati da file" },
  offlineAfterS: 365 * 24 * 3600,
  metrics: [
    { key: "quantity", label: { en: "Quantity", it: "Quantità" }, unit: "", decimals: 2 },
    { key: "dose", label: { en: "Dose", it: "Dose" }, unit: "", decimals: 2 },
    { key: "area", label: { en: "Area", it: "Superficie" }, unit: "", decimals: 2 },
  ],
  defaults: {},
  settings: [],
  rules: () => [],
  alertText: () => "",
};
