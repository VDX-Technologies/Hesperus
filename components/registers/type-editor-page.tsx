import { getT } from "@/lib/i18n";
import type { TenantDb } from "@/lib/engine/db";
import { FIELD_TYPES, label, subjectTypes } from "@/lib/engine/registers";
import type { EventFormState } from "@/components/event-form";
import { TypeEditor, type TypeDraft } from "@/components/registers/type-editor";

/** The schema editor of an event or object type, saved by the console's own server action. */
export async function TypeEditorPage({ db, slug, kind, draft, action }: {
  db: TenantDb;
  slug: string;
  kind: "event" | "object";
  draft?: TypeDraft;
  action: (prev: EventFormState, form: FormData) => Promise<EventFormState>;
}) {
  const { t, locale } = await getT();
  const subjects = (await subjectTypes(db)).map((s) => ({ value: s.type, label: label(s.name, locale, s.type) }));
  const title = kind === "object" ? (draft ? t.editObjectType : t.newObjectType) : draft ? t.editType : t.newType;
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="card mt-6 p-4">
        <TypeEditor
          slug={slug}
          action={action}
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
