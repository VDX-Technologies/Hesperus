import { getT } from "@/lib/i18n";
import { ObjectTypesView } from "@/components/registers/object-types-view";
import { registerContext } from "../context";

/** The organization's own object types, in the registers. */
export default async function ObjectTypes(props: PageProps<"/terra/o/[slug]/registers/objects">) {
  const { slug } = await props.params;
  const ctx = await registerContext(slug);
  const { t } = await getT();
  const base = `/terra/o/${slug}/registers`;
  return (
    <ObjectTypesView
      db={ctx.db}
      author={ctx.author}
      back={{ href: base, label: t.registers }}
      paths={{
        types: `${base}/objects`,
        objects: (x) => `${base}/objects/${encodeURIComponent(x)}`,
        editType: (key) => `${base}/types?kind=object${key ? `&key=${key}` : ""}`,
      }}
    />
  );
}
