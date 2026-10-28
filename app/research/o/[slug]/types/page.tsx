import { getT } from "@/lib/i18n";
import { ObjectTypesView } from "@/components/registers/object-types-view";
import { researchContext } from "../context";
import { researchPaths } from "../paths";

export default async function Types(props: PageProps<"/research/o/[slug]/types">) {
  const { slug } = await props.params;
  const { db, author } = await researchContext(slug);
  const { t } = await getT();
  return <ObjectTypesView db={db} author={author} back={{ href: `/research/o/${slug}`, label: t.projects }} paths={researchPaths(slug)} />;
}
