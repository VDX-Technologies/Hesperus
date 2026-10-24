import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { CUSTOM } from "@/lib/engine/registers";
import { getObjectType } from "@/lib/engine/custom-objects";
import { objectTypeDraft } from "@/lib/type-drafts";
import { TypeEditorPage } from "@/components/registers/type-editor-page";
import { saveObjectTypeAction } from "../../actions";
import { researchContext } from "../../context";

export default async function EditType(props: { params: Promise<{ slug: string }>; searchParams: Promise<{ key?: string | string[] }> }) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const ctx = await researchContext(slug);
  if (ctx.author.role !== "owner") notFound();
  const key = typeof sp.key === "string" ? sp.key : "";
  let draft;
  if (key) {
    const type = await getObjectType(ctx.db, `${CUSTOM}.${key}`);
    if (!type) notFound();
    const { locale } = await getT();
    draft = objectTypeDraft(type, locale);
  }
  return <TypeEditorPage db={ctx.db} slug={slug} kind="object" draft={draft} action={saveObjectTypeAction} />;
}
