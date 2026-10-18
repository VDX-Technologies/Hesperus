import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { CUSTOM, FIELD_TYPES, label, subjectTypes } from "@/lib/engine/registers";
import { TypeEditor, type TypeDraft } from "@/components/registers/type-editor";
import { registerContext, typeFrom } from "../context";

export default async function EditType(props: PageProps<"/o/[slug]/registers/types">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const ctx = await registerContext(slug);
  if (ctx.author.role !== "owner") notFound();
  const { t, locale } = await getT();
  const key = typeof sp.key === "string" ? sp.key : "";
  const existing = key ? await typeFrom(ctx, `${CUSTOM}.${key}`) : null;
  if (key && !existing) notFound();
  const subjects = (await subjectTypes(ctx.db)).map((s) => ({ value: s.type, label: label(s.name, locale, s.type) }));
  const draft: TypeDraft | undefined = existing
    ? {
        key: existing.key,
        name: { it: existing.name.it ?? "", en: existing.name.en ?? "" },
        subject: existing.subject ?? "",
        fields: Object.entries(existing.fields).map(([k, s]) => ({
          key: k,
          label: s.label?.[locale] ?? s.label?.en ?? "",
          type: s.type,
          required: !!s.required,
          units: (s.units ?? []).join(", "),
          options: (s.enum ?? []).map(String).join(", "),
          fromSubject: existing.fromSubject[k] ?? "",
        })),
      }
    : undefined;
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">{existing ? t.editType : t.newType}</h1>
      <div className="card mt-6 p-4">
        <TypeEditor
          slug={slug}
          locale={locale}
          initial={draft}
          subjects={subjects}
          fieldTypes={[...FIELD_TYPES]}
          text={{
            key: t.typeKey, nameIt: t.typeNameIt, nameEn: t.typeNameEn, subject: t.typeSubject, fields: t.typeFields,
            addField: t.addField, remove: t.remove, fieldKey: t.typeKey, fieldLabel: t.fieldLabel, fieldType: t.fieldType,
            required: t.required, units: t.fieldUnits, options: t.fieldOptions, fromSubject: t.fromSubject, save: t.save,
            choose: t.choose,
          }}
        />
      </div>
    </div>
  );
}
