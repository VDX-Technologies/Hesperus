import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { CUSTOM } from "@/lib/engine/registers";
import { getObjectType } from "@/lib/engine/custom-objects";
import { objectTypeDraft } from "@/lib/type-drafts";
import { TypeEditorPage } from "@/components/registers/type-editor-page";
import { saveObjectTypeAction } from "../../actions";
import { researchContext } from "../../context";

export default async function EditType(props: PageProps<"/research/o/[slug]/types/edit">) {
  const { slug } = await props.params;
  const { key } = await props.searchParams;
  const { db, author } = await researchContext(slug);
  if (author.role !== "owner") notFound();
  const { locale } = await getT();
  let draft;
  if (typeof key === "string" && key) {
    const o = await getObjectType(db, `${CUSTOM}.${key}`);
    if (!o) notFound();
    draft = objectTypeDraft(o, locale);
  }
  return <TypeEditorPage db={db} slug={slug} kind="object" draft={draft} action={saveObjectTypeAction} />;
}
