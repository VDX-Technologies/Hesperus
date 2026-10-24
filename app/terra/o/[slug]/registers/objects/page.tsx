import Link from "next/link";
import { getT } from "@/lib/i18n";
import { label } from "@/lib/engine/registers";
import { listObjectTypes } from "@/lib/engine/custom-objects";
import { registerContext } from "../context";

/** The organization's own object types (projects, datasets, results...), with how many objects each has. */
export default async function ObjectTypes(props: PageProps<"/terra/o/[slug]/registers/objects">) {
  const { slug } = await props.params;
  const ctx = await registerContext(slug);
  const { t, locale } = await getT();
  const types = await listObjectTypes(ctx.db);
  const { rows } = await ctx.db.query<{ key: string; n: number }>(
    `select t.key, count(o.id)::int n from object_types t left join objects o on o.tenant_id = t.tenant_id and o.type_id = t.id
      where t.tenant_id = $1 and t.module = 'custom' group by 1`,
    [ctx.org.id],
  );
  const counts = new Map(rows.map((r) => [r.key, r.n]));
  const owner = ctx.author.role === "owner";
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.objectTypes}</h1>
        <div className="flex gap-3 text-xs">
          <Link href={`/terra/o/${slug}/registers`} className="text-dim hover:underline">← {t.registers}</Link>
          {owner && <Link href={`/terra/o/${slug}/registers/types?kind=object`} className="text-frost hover:underline">+ {t.newObjectType}</Link>}
        </div>
      </div>
      {types.length ? (
        <ul className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {types.map((x) => (
            <li key={x.type} className="card p-3 text-sm">
              <Link href={`/terra/o/${slug}/registers/objects/${encodeURIComponent(x.type)}`} className="block hover:underline">
                <div className="font-medium">{label(x.name, locale, x.key)}</div>
                <div className="text-xs text-dim"><span className="num">{counts.get(x.key) ?? 0}</span> {t.objects.toLowerCase()}</div>
              </Link>
              {owner && <Link href={`/terra/o/${slug}/registers/types?kind=object&key=${x.key}`} className="mt-1 inline-block text-xs text-frost hover:underline">{t.editObjectType}</Link>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-dim">{t.noObjectsOfType}</p>
      )}
    </div>
  );
}
