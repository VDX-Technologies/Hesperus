// VDX Research as configuration: the types a research organization needs, saved through the
// same engine APIs the schema editor uses. Nothing here is known to the engine; running it
// again replaces the definitions in place, so it is the versioned copy of the editor's work.
import type { TenantDb } from "../../lib/engine/db";
import type { Author } from "../../lib/engine/manual";
import { saveEventType, type EventTypeInput } from "../../lib/engine/registers";
import { saveObjectType, type ObjectTypeInput } from "../../lib/engine/custom-objects";

const l = (it: string, en: string) => ({ it, en });

export const objectTypes: ObjectTypeInput[] = [
  {
    key: "project",
    name: l("Progetto", "Project"),
    properties: {
      area: { type: "string", required: true, label: l("Area", "Area") },
      question: { type: "string", label: l("Domanda", "Question") },
      hypothesis: { type: "string", label: l("Ipotesi", "Hypothesis") },
      stage: {
        type: "string", required: true, label: l("Stato", "Stage"),
        enum: ["preparation", "running", "done"],
        options: { preparation: l("In preparazione", "Preparation"), running: l("In corso", "Running"), done: l("Concluso", "Done") },
      },
      started: { type: "timestamp", label: l("Inizio", "Start") },
      ended: { type: "timestamp", label: l("Fine", "End") },
      protocol: { type: "string", label: l("Link protocollo", "Protocol link") },
      // one link per line, "Label https://...{tic_id}": a result's pages in outside catalogs
      result_links: { type: "string", format: "text", label: l("Link esterni dei risultati", "Result links") },
      // the properties of this project's results (TIC id, gene, enzyme...), set per project
      result_schema: { type: "object", format: "schema", label: l("Proprietà dei risultati", "Result properties") },
    },
  },
  {
    key: "dataset",
    name: l("Dataset", "Dataset"),
    properties: {
      source: { type: "string", required: true, label: l("Fonte", "Source") },
      description: { type: "string", label: l("Descrizione", "Description") },
      size: { type: "string", label: l("Dimensione", "Size") },
      url: { type: "string", label: l("Link", "Link") },
      license: { type: "string", label: l("Licenza", "License") },
    },
  },
  {
    key: "result",
    name: l("Risultato", "Result"),
    properties: {
      score: { type: "number", required: true, label: l("Punteggio", "Score") },
      reference: {
        type: "string", label: l("Stato nei cataloghi", "Reference status"),
        enum: ["known", "known_other", "absent"],
        options: { known: l("Noto", "Known"), known_other: l("Noto con classificazione diversa", "Known, other class"), absent: l("Non presente", "Absent") },
      },
      review: {
        type: "string", required: true, label: l("Revisione", "Review"),
        enum: ["to_review", "discarded", "interesting", "sent"],
        options: {
          to_review: l("Da rivedere", "To review"), discarded: l("Scartato", "Discarded"),
          interesting: l("Interessante", "Interesting"), sent: l("Inviato a un ricercatore", "Sent to a researcher"),
        },
      },
      note: { type: "string", format: "text", label: l("Note", "Notes") },
      // the email of the member who should look at it
      assignee: { type: "string", label: l("Assegnato a", "Assigned to") },
      // the id of the run (an event) that produced it
      run: { type: "integer", label: l("Esecuzione", "Run") },
      extra: { type: "object", schemaFrom: "project.result_schema", label: l("Proprietà del progetto", "Project properties") },
    },
    links: { project: { type: "custom.project", required: true } },
  },
  {
    // a saved search of a project's results: its filters, sort and columns, shared with the team
    key: "view",
    name: l("Vista salvata", "Saved view"),
    properties: { query: { type: "string", required: true, label: l("Filtri", "Filters") } },
    links: { project: { type: "custom.project", required: true } },
  },
];

export const eventTypes: EventTypeInput[] = [
  {
    key: "run",
    name: l("Esecuzione", "Run"),
    subject: "custom.project",
    also: ["custom.dataset"],
    fields: {
      commit: { type: "string", required: true, label: l("Commit", "Commit") },
      params: { type: "object", label: l("Parametri", "Parameters") },
      items: { type: "integer", min: 0, label: l("N. elementi", "Items") },
      duration_s: { type: "number", min: 0, label: l("Durata (s)", "Duration (s)") },
      outcome: {
        type: "string", required: true, label: l("Esito", "Outcome"),
        enum: ["ok", "partial", "failed"],
        options: { ok: l("Riuscita", "Succeeded"), partial: l("Parziale", "Partial"), failed: l("Fallita", "Failed") },
      },
    },
  },
  {
    key: "lab_note",
    name: l("Nota di laboratorio", "Lab note"),
    subject: "custom.project",
    fields: { text: { type: "string", format: "text", required: true, label: l("Testo", "Text") } },
  },
  {
    key: "comment",
    name: l("Commento", "Comment"),
    subject: "custom.result",
    fields: {
      text: { type: "string", format: "text", required: true, label: l("Testo", "Text") },
      // the comment it answers, for threads
      reply_to: { type: "integer", min: 1, label: l("In risposta a", "Reply to") },
    },
  },
];

/** Saves every type, objects first since the events point at them; returns the type names. */
export async function seedResearch(db: TenantDb, owner: Author): Promise<string[]> {
  const saved: string[] = [];
  for (const t of objectTypes) saved.push(await saveObjectType(db, owner, t));
  for (const t of eventTypes) saved.push(await saveEventType(db, owner, t));
  return saved;
}
