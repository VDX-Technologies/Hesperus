import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { CUSTOM } from "@/lib/engine/registers";
import { getObjectType } from "@/lib/engine/custom-objects";
import { fieldDrafts, objectTypeDraft } from "@/lib/type-drafts";
import type { TypeDraft } from "@/components/registers/type-editor";
import { TypeEditorPage } from "@/components/registers/type-editor-page";
import { saveObjectTypeAction, saveType } from "../actions";
import { registerContext, typeFrom } from "../context";

export default async function EditType(props: PageProps<"/terra/o/[slug]/registers/types">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const ctx = await registerContext(slug);
  if (ctx.author.role !== "owner") notFound();
  const { locale } = await getT();
  const kind = sp.kind === "object" ? "object" : "event";
  const key = typeof sp.key === "string" ? sp.key : "";
  let draft: TypeDraft | undefined;
  if (key && kind === "object") {
    const o = await getObjectType(ctx.db, `${CUSTOM}.${key}`);
    if (!o) notFound();
    draft = objectTypeDraft(o, locale);
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
  return <TypeEditorPage db={ctx.db} slug={slug} kind={kind} draft={draft} action={kind === "object" ? saveObjectTypeAction : saveType} />;
}
