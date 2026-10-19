// Console side of Records: no settings and no rules, a register only stores what happened.
import type { PackageDef } from "../types";

/** Fields a file column can be mapped to, in form order. */
export const RECORD_FIELDS = ["date", "subject", "kind", "quantity", "unit", "product", "dose", "area", "operator", "note"] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];
export const REQUIRED_FIELDS: RecordField[] = ["date", "subject"];

/** Words a column header is usually written with, per field (Italian and English). */
const FIELD_WORDS: Record<RecordField, string[]> = {
  date: ["data", "date", "giorno", "day", "quando", "when", "timestamp", "ora", "time"],
  subject: ["soggetto", "subject", "campo", "appezzamento", "particella", "parcella", "appezz", "vigna", "vigneto", "coltura", "lotto", "settore", "serra", "animale", "capo", "mezzo", "macchina", "località", "localita", "luogo", "zona", "field", "plot", "block", "site", "location", "crop"],
  kind: ["tipo", "kind", "type", "categoria", "category", "operazione", "attivita", "attività", "lavorazione", "intervento"],
  quantity: ["quantita", "quantità", "qta", "qty", "quantity", "kg", "q.li", "quintali", "litri", "peso", "weight", "totale", "amount"],
  unit: ["unita", "unità", "um", "u.m.", "unit", "units", "misura"],
  product: ["prodotto", "product", "formulato", "principio", "fitofarmaco", "concime", "fertilizzante", "materiale", "articolo", "item"],
  dose: ["dose", "dosaggio", "dosage", "rate"],
  area: ["superficie", "area", "ha", "ettari", "hectares", "estensione", "sup"],
  operator: ["operatore", "operator", "addetto", "tecnico", "responsabile", "eseguito", "nome", "worker", "user", "utente"],
  note: ["note", "nota", "notes", "osservazioni", "commento", "commenti", "comments", "descrizione", "description", "memo"],
};

const words = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, " ").split(/[^a-z0-9.]+/).filter(Boolean);

/**
 * The field each header most likely fills, or "" for none. A header matches a field when its
 * first word, or failing that any word, is one of the field's words; a field goes to one column only.
 */
export function guessFields(headers: string[]): (RecordField | "")[] {
  const vocab = Object.entries(FIELD_WORDS).map(([f, w]) => [f as RecordField, new Set(w.flatMap(words))] as const);
  const used = new Set<RecordField>();
  const out: (RecordField | "")[] = headers.map(() => "");
  // first words first ("Dose (l/ha)", "Superficie ha"), then any word ("Data trattamento" is already a date)
  for (const pass of [0, 1])
    headers.forEach((h, i) => {
      if (out[i]) return;
      const ws = words(h);
      const hit = vocab.find(([f, v]) => !used.has(f) && (pass === 0 ? v.has(ws[0] ?? "") : ws.some((w) => v.has(w))));
      if (hit) {
        out[i] = hit[0];
        used.add(hit[0]);
      }
    });
  return out;
}

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
