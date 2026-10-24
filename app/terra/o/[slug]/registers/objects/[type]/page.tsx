import { notFound } from "next/navigation";
import { getObjectType } from "@/lib/engine/custom-objects";
import { ObjectsView } from "@/components/registers/objects-view";
import { deleteObjectAction, saveObjectAction } from "../../actions";
import { registerContext } from "../../context";

/** The objects of one custom type, in the registers. */
export default async function Objects(props: PageProps<"/terra/o/[slug]/registers/objects/[type]">) {
  const { slug, type: param } = await props.params;
  const ctx = await registerContext(slug);
  const type = await getObjectType(ctx.db, decodeURIComponent(param));
  if (!type) notFound();
  const base = `/terra/o/${slug}/registers`;
  return (
    <ObjectsView
      slug={slug}
      db={ctx.db}
      author={ctx.author}
      type={type}
      sp={await props.searchParams}
      paths={{
        types: `${base}/objects`,
        objects: (x) => `${base}/objects/${encodeURIComponent(x)}`,
        editType: (key) => `${base}/types?kind=object${key ? `&key=${key}` : ""}`,
      }}
      saveAction={saveObjectAction}
      deleteAction={deleteObjectAction}
    />
  );
}
