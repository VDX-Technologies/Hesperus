import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { CUSTOM, FIELD_TYPES, label, subjectTypes } from "@/lib/engine/registers";
import { getObjectType } from "@/lib/engine/custom-objects";
import type { Schema } from "@/lib/engine/schema";
import { TypeEditor, type FieldDraft, type TypeDraft } from "@/components/terra/registers/type-editor";
import { registerContext, typeFrom } from "../context";

const fieldDrafts = (schema: Schema, locale: string, fromSubject: Record<string, string> = {}): FieldDraft[] =>
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
  }));

/** The schema editor: `?key=` edits an event type, `?kind=object&key=` an object type. */
export default async function EditType(props: PageProps<"/terra/o/[slug]/registers/types">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const ctx = await registerContext(slug);
  if (ctx.author.role !== "owner") notFound();
  const { t, locale } = await getT();
  const kind = sp.kind === "object" ? "object" : "event";
  const key = typeof sp.key === "string" ? sp.key : "";
  let draft: TypeDraft | undefined;
  if (key && kind === "object") {
    const o = await getObjectType(ctx.db, `${CUSTOM}.${key}`);
    if (!o) notFound();
    draft = {
      key: o.key,
      name: { it: o.name.it ?? "", en: o.name.en ?? "" },
      subject: "",
      fields: fieldDrafts(o.properties, locale),
      links: Object.entries(o.links).map(([k, l]) => ({ key: k, type: l.type, required: !!l.required })),
    };
  } else if (key) {
    const e = await typeFrom(ctx, `${CUSTOM}.${key}`);
    if (!e) notFound();
    draft = {
      key: e.key,
      name: { it: e.name.it ?? "", en: e.name.en ?? "" },
      subject: e.subject ?? "",
      fields: fieldDrafts(e.fields, locale, e.fromSubject),
      also: e.also,
    };
  }
  const subjects = (await subjectTypes(ctx.db)).map((s) => ({ value: s.type, label: label(s.name, locale, s.type) }));
  const title = kind === "object" ? (draft ? t.editObjectType : t.newObjectType) : draft ? t.editType : t.newType;
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="card mt-6 p-4">
        <TypeEditor
          slug={slug}
          locale={locale}
          kind={kind}
          initial={draft}
          subjects={subjects}
          fieldTypes={[...FIELD_TYPES]}
          text={{
            key: t.typeKey, nameIt: t.typeNameIt, nameEn: t.typeNameEn, subject: t.typeSubject,
            fields: kind === "object" ? t.typeProperties : t.typeFields,
            addField: t.addField, remove: t.remove, fieldKey: t.typeKey, fieldLabel: t.fieldLabel, fieldType: t.fieldType,
            required: t.required, units: t.fieldUnits, options: t.fieldOptions, fromSubject: t.fromSubject, save: t.save,
            choose: t.choose, also: t.typeAlso, links: t.typeLinks, addLink: t.addLink, linkType: t.linkType,
            holdsSchema: t.holdsSchema, schemaFrom: t.schemaFrom,
          }}
        />
      </div>
    </div>
  );
}
