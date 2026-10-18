import Link from "next/link";
import { getT } from "@/lib/i18n";
import { label, listEventTypes } from "@/lib/engine/registers";
import { registerContext } from "./context";

export default async function Registers(props: PageProps<"/o/[slug]/registers">) {
  const { slug } = await props.params;
  const ctx = await registerContext(slug);
  const { t, locale } = await getT();
  const types = await listEventTypes(ctx.db, ctx.pkgs);
  const { rows } = await ctx.db.query<{ type: string; n: number }>(
    `select type, count(*)::int n from events_current where tenant_id = $1 and type = any($2) group by 1`,
    [ctx.org.id, types.map((x) => x.type)],
  );
  const counts = new Map(rows.map((r) => [r.type, r.n]));
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.registers}</h1>
        {ctx.author.role === "owner" && <Link href={`/o/${slug}/registers/types`} className="text-xs text-frost hover:underline">+ {t.newType}</Link>}
      </div>
      {types.length ? (
        <ul className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {types.map((x) => (
            <li key={x.type}>
              <Link href={`/o/${slug}/registers/${encodeURIComponent(x.type)}`} className="card block p-3 text-sm hover:border-frost">
                <div className="font-medium">{label(x.name, locale, x.key)}</div>
                <div className="text-xs text-dim">{x.custom ? t.customType : x.module} · <span className="num">{counts.get(x.type) ?? 0}</span> {t.entries.toLowerCase()}</div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-dim">{t.noRegisters}</p>
      )}
    </div>
  );
}
