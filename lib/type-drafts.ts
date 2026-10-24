// A type as the schema editor edits it: the drafts it starts from, filled from what is saved.
import type { Schema } from "./engine/schema";
import type { ObjectTypeInfo } from "./engine/custom-objects";
import type { FieldDraft, TypeDraft } from "../components/registers/type-editor";

export const fieldDrafts = (schema: Schema, locale: string, fromSubject: Record<string, string> = {}): FieldDraft[] =>
  Object.entries(schema).map(([k, s]) => ({
    key: k,
    label: s.label?.[locale] ?? s.label?.en ?? "",
    type: s.type,
    required: !!s.required,
    units: (s.units ?? []).join(", "),
    options: (s.enum ?? []).map(String).join(", "),
    fromSubject: fromSubject[k] ?? "",
    holdsSchema: s.format === "schema",
    schemaFrom: s.schemaFrom ?? "",
    multiline: s.format === "text",
  }));

/** The draft of a saved custom object type. */
export const objectTypeDraft = (o: ObjectTypeInfo, locale: string): TypeDraft => ({
  key: o.key,
  name: { it: o.name.it ?? "", en: o.name.en ?? "" },
  subject: "",
  fields: fieldDrafts(o.properties, locale),
  links: Object.entries(o.links).map(([k, l]) => ({ key: k, type: l.type, required: !!l.required })),
});
