// The treatments register as a PDF laid out like the paper one, columns in COLUMNS order.
import { tablePdf } from "../../engine/pdf";
import { COLUMNS, COLUMN_LABELS, cell, type Column, type RegisterRow } from "./register";

const WIDTHS: Record<Column, number> = { crop: 0.16, areaHa: 0.08, phase: 0.09, adversity: 0.15, product: 0.15, quantity: 0.09, date: 0.08, notes: 0.2 };

export async function registerPdf(
  rows: Iterable<RegisterRow> | AsyncIterable<RegisterRow>,
  meta: { organization: string; period: string; locale: "en" | "it" },
): Promise<Uint8Array> {
  const l = meta.locale;
  async function* cells() {
    for await (const r of rows) yield COLUMNS.map((c) => cell(r, c, l));
  }
  return tablePdf({
    title: l === "it" ? "Registro dei trattamenti" : "Treatments register",
    subtitle: `${meta.organization} · ${meta.period}`,
    columns: COLUMNS.map((c) => ({ label: COLUMN_LABELS[c][l], width: WIDTHS[c] })),
    rows: cells(),
    empty: l === "it" ? "Nessun trattamento nel periodo." : "No treatments in the period.",
  });
}
