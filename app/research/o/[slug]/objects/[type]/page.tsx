import { notFound } from "next/navigation";
import { getObjectType } from "@/lib/engine/custom-objects";
import { ObjectsView } from "@/components/registers/objects-view";
import { deleteObjectAction, saveObjectAction } from "../../actions";
import { researchContext } from "../../context";

export default async function Objects(props: { params: Promise<{ slug: string; type: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug, type: param } = await props.params;
  const ctx = await researchContext(slug);
  const type = await getObjectType(ctx.db, decodeURIComponent(param));
  if (!type) notFound();
  const base = `/research/o/${slug}`;
  return <ObjectsView slug={slug} db={ctx.db} author={ctx.author} type={type} sp={await props.searchParams} paths={{
    types: `${base}/types`, objects: (x) => `${base}/objects/${encodeURIComponent(x)}`,
    editType: (key) => `${base}/types/edit?kind=object${key ? `&key=${encodeURIComponent(key)}` : ""}`,
  }} saveAction={saveObjectAction} deleteAction={deleteObjectAction} />;
}
