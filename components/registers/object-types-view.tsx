import Link from "next/link";
import { getT } from "@/lib/i18n";
import { label } from "@/lib/engine/registers";
import { listObjectTypes } from "@/lib/engine/custom-objects";
import type { TenantDb } from "@/lib/engine/db";
import type { Author } from "@/lib/engine/manual";
import type { ObjectPaths } from "./objects-view";

export async function ObjectTypesView({ db, author, paths, back }: {
  db: TenantDb;
  author: Author;
  paths: ObjectPaths;
  back?: { href: string; label: string };
}) {
  const { t, locale } = await getT();
  const types = await listObjectTypes(db);
  const { rows } = await db.query<{ key: string; n: number }>(
    `select t.key, count(o.id)::int n from object_types t left join objects o on o.tenant_id = t.tenant_id and o.type_id = t.id
      where t.tenant_id = $1 and t.module = 'custom' group by 1`,
    [db.tenantId],
  );
  const counts = new Map(rows.map((r) => [r.key, r.n]));
  const owner = author.role === "owner";
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.objectTypes}</h1>
        <div className="flex gap-3 text-xs">
          {back && <Link href={back.href} className="text-dim hover:underline">← {back.label}</Link>}
          {owner && <Link href={paths.editType()} className="text-frost hover:underline">+ {t.newObjectType}</Link>}
        </div>
      </div>
      {types.length ? (
        <ul className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {types.map((x) => (
            <li key={x.type} className="card p-3 text-sm">
              <Link href={paths.objects(x.type)} className="block hover:underline">
                <div className="font-medium">{label(x.name, locale, x.key)}</div>
                <div className="text-xs text-dim"><span className="num">{counts.get(x.key) ?? 0}</span> {t.objects.toLowerCase()}</div>
              </Link>
              {owner && <Link href={paths.editType(x.key)} className="mt-1 inline-block text-xs text-frost hover:underline">{t.editObjectType}</Link>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-dim">{t.noObjectsOfType}</p>
      )}
    </div>
  );
}
