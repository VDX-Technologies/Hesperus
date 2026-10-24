import Link from "next/link";
import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { listEvents } from "@/lib/engine/events";
import { fieldText, getEventType, label } from "@/lib/engine/registers";
import { getObject, getObjectType, searchObjects } from "@/lib/engine/custom-objects";
import { getSettings, num } from "@/lib/engine/settings";
import { projectFields, RESEARCH, resultFilters } from "@/lib/research";
import { researchContext } from "../../context";

/** A project: its properties, its run history and its results, filtered by score and review. */
export default async function Project(props: PageProps<"/research/o/[slug]/p/[id]">) {
  const { slug, id } = await props.params;
  const sp = await props.searchParams;
  const { db } = await researchContext(slug);
  const { t, locale } = await getT();
  const [project, type, resultType, runType] = await Promise.all([
    getObject(db, id), getObjectType(db, RESEARCH.project), getObjectType(db, RESEARCH.result), getEventType(db, [], RESEARCH.run),
  ]);
  if (!project || !type || project.type !== type.type) notFound();

  const pageSize = num(await getSettings(db.shared), "objects.page_size", 100);
  const { page, ...filters } = resultFilters(sp, project.id);
  const [runs, { objects: results, total }] = await Promise.all([
    listEvents(db, { types: [RESEARCH.run], objectId: project.id, recursive: false, limit: 50 }),
    resultType ? searchObjects(db, RESEARCH.result, { ...filters, limit: pageSize, offset: (page - 1) * pageSize }) : { objects: [], total: 0 },
  ]);

  const own = projectFields(project);
  const shown = Object.entries(type.properties).filter(([k, s]) => s.type !== "object" && project.properties[k] !== undefined);
  const runCols = Object.entries(runType?.fields ?? {}).filter(([, s]) => s.type !== "object");
  // the result's own scalar properties, then the project's fields held in `extra`
  const cols = Object.entries(resultType?.properties ?? {}).filter(([k, s]) => s.type !== "object" && k !== RESEARCH.note);
  const extraCols = Object.entries(own).filter(([, s]) => s.type !== "object");
  const review = resultType?.properties[RESEARCH.review];
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const base = `/research/o/${slug}/p/${project.id}`;
  const query = (p: number) => {
    const q = new URLSearchParams(Object.entries({ min: one("min"), max: one("max"), review: one("review"), order: one("order") }).filter(([, v]) => v));
    if (p > 1) q.set("page", String(p));
    return `${base}?${q}`;
  };

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        <div className="flex gap-3 text-xs">
          <Link href={`/research/o/${slug}`} className="text-dim hover:underline">← {t.projects}</Link>
          <Link href={`/research/o/${slug}/objects/${encodeURIComponent(type.type)}?edit=${project.id}#new`} className="text-frost hover:underline">{t.edit}</Link>
        </div>
      </div>

      <dl className="card mt-6 grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {shown.map(([k, s]) => (
          <div key={k}>
            <dt className="text-xs text-dim">{label(s.label, locale, k)}</dt>
            <dd className="break-words">{fieldText(s, project.properties[k], locale)}</dd>
          </div>
        ))}
      </dl>

      <section className="mt-8">
        <h2 className="text-sm font-medium">{t.runs}</h2>
        {runs.length ? (
          <div className="card mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-dim">
                <tr><th className="px-3 py-2">{t.date}</th>{runCols.map(([k, s]) => <th key={k} className="px-3 py-2">{label(s.label, locale, k)}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {runs.map((e) => (
                  <tr key={e.id}>
                    <td className="num whitespace-nowrap px-3 py-2">{e.ts.toLocaleString(locale)}</td>
                    {runCols.map(([k, s]) => <td key={k} className="px-3 py-2">{fieldText(s, e.payload[k], locale)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-dim">{t.noRuns}</p>
        )}
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">{t.results}</h2>
          <span className="text-xs text-dim"><span className="num">{total}</span> {t.resultsShown}</span>
        </div>
        <form className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label className="block"><span className="text-xs text-dim">{t.scoreMin}</span>
            <input name="min" defaultValue={one("min")} inputMode="decimal" className="mt-1 w-24" /></label>
          <label className="block"><span className="text-xs text-dim">{t.scoreMax}</span>
            <input name="max" defaultValue={one("max")} inputMode="decimal" className="mt-1 w-24" /></label>
          {review?.enum && (
            <label className="block"><span className="text-xs text-dim">{label(review.label, locale, RESEARCH.review)}</span>
              <select name="review" defaultValue={one("review")} className="mt-1">
                <option value="">{t.allReviews}</option>
                {review.enum.map((v) => <option key={String(v)} value={String(v)}>{fieldText(review, v, locale)}</option>)}
              </select></label>
          )}
          <label className="block"><span className="text-xs text-dim">&nbsp;</span>
            <select name="order" defaultValue={one("order")} className="mt-1">
              <option value="">{t.highestFirst}</option>
              <option value="asc">{t.lowestFirst}</option>
            </select></label>
          <button className="btn">{t.filter}</button>
          <Link href={base} className="text-xs text-dim hover:underline">{t.clearFilters}</Link>
        </form>
        {results.length ? (
          <div className="card mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-dim">
                <tr>
                  <th className="px-3 py-2">{t.objectName}</th>
                  {cols.map(([k, s]) => <th key={k} className="px-3 py-2">{label(s.label, locale, k)}</th>)}
                  {extraCols.map(([k, s]) => <th key={`x.${k}`} className="px-3 py-2">{label(s.label, locale, k)}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {results.map((r) => {
                  const extra = (r.properties[RESEARCH.extra] ?? {}) as Record<string, unknown>;
                  return (
                    <tr key={r.id}>
                      <td className="px-3 py-2"><Link href={`/research/o/${slug}/r/${r.id}`} className="text-frost hover:underline">{r.name}</Link></td>
                      {cols.map(([k, s]) => <td key={k} className={s.type === "number" || s.type === "integer" ? "num px-3 py-2" : "px-3 py-2"}>{fieldText(s, r.properties[k], locale)}</td>)}
                      {extraCols.map(([k, s]) => <td key={`x.${k}`} className="px-3 py-2">{fieldText(s, extra[k], locale)}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-dim">{t.noResults}</p>
        )}
        <div className="mt-3 flex gap-4 text-xs">
          {page > 1 && <Link href={query(1)} className="text-frost hover:underline">{t.firstPage}</Link>}
          {page * pageSize < total && <Link href={query(page + 1)} className="text-frost hover:underline">{t.nextPage}</Link>}
        </div>
      </section>
    </div>
  );
}
