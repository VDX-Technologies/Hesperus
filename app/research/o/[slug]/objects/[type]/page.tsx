import { notFound } from "next/navigation";
import { getObjectType } from "@/lib/engine/custom-objects";
import { ObjectsView } from "@/components/registers/objects-view";
import { deleteObjectAction, saveObjectAction } from "../../actions";
import { researchContext } from "../../context";
import { researchPaths } from "../../paths";

export default async function Objects(props: PageProps<"/research/o/[slug]/objects/[type]">) {
  const { slug, type: param } = await props.params;
  const { db, author } = await researchContext(slug);
  const type = await getObjectType(db, decodeURIComponent(param));
  if (!type) notFound();
  return (
    <ObjectsView
      slug={slug}
      db={db}
      author={author}
      type={type}
      sp={await props.searchParams}
      paths={researchPaths(slug)}
      saveAction={saveObjectAction}
      deleteAction={deleteObjectAction}
    />
  );
}
