import { getT } from "@/lib/i18n";
import { ObjectTypesView } from "@/components/registers/object-types-view";
import { researchContext } from "../context";

export default async function Types(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const ctx = await researchContext(slug);
  const { t } = await getT();
  const base = `/research/o/${slug}`;
  return <ObjectTypesView db={ctx.db} author={ctx.author} back={{ href: base, label: t.projects }} paths={{
    types: `${base}/types`, objects: (type) => `${base}/objects/${encodeURIComponent(type)}`,
    editType: (key) => `${base}/types/edit${key ? `?kind=object&key=${encodeURIComponent(key)}` : ""}`,
  }} />;
}
