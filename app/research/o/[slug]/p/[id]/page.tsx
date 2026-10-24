import Link from "next/link";
import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { listEvents } from "@/lib/engine/events";
import { fieldText, getEventType, label } from "@/lib/engine/registers";
import { getObject, getObjectType, searchObjects } from "@/lib/engine/custom-objects";
import { getSettings, num } from "@/lib/engine/settings";
import { canRecord } from "@/lib/engine/manual";
import type { PropertySpec } from "@/lib/engine/package";
import { filterQuery, projectFields, RESEARCH, resultFilters } from "@/lib/research";
import { CheckAll } from "@/components/check-all";
import { Flash } from "@/components/flash";
import { SubmitButton } from "@/components/submit-button";
import { reviewMany } from "../../actions";
import { assignees, researchContext } from "../../context";

const isNumber = (s: PropertySpec) => s.type === "number" || s.type === "integer";

/**
 * A project: its properties, its run history and its results, searched, filtered on any of their
 * properties (the project's own fields too) and sorted by column, with batch review and assignment.
 */
export default async function Project(props: PageProps<"/research/o/[slug]/p/[id]">) {
  const { slug, id } = await props.params;
  const sp = await props.searchParams;
  const { org, db, author } = await researchContext(slug);
  const { t, locale } = await getT();
  const [project, type, resultType, runType] = await Promise.all([
    getObject(db, id), getObjectType(db, RESEARCH.project), getObjectType(db, RESEARCH.result), getEventType(db, [], RESEARCH.run),
  ]);
  if (!project || !type || project.type !== type.type) notFound();

  const pageSize = num(await getSettings(db.shared), "objects.page_size", 100);
  const own = projectFields(project);
  const assignable = !!resultType?.properties[RESEARCH.assignee];
  const { page, ...filters } = resultFilters(sp, project.id, { result: resultType?.properties, own, me: author.email });
  const [runs, { objects: results, total }] = await Promise.all([
    listEvents(db, { types: [RESEARCH.run], objectId: project.id, recursive: false, limit: 50 }),
    resultType ? searchObjects(db, RESEARCH.result, { ...filters, limit: pageSize, offset: (page - 1) * pageSize }) : { objects: [], total: 0 },
  ]);

  const members = assignable ? await assignees(org.id) : [];
  const editor = canRecord(author.role);
  const shown = Object.entries(type.properties).filter(([k, s]) => s.type !== "object" && project.properties[k] !== undefined);
  const runCols = Object.entries(runType?.fields ?? {}).filter(([, s]) => s.type !== "object");
  // the result's own scalar properties, then the project's fields held in `extra`
  const cols = Object.entries(resultType?.properties ?? {}).filter(([k, s]) => s.type !== "object" && k !== RESEARCH.note);
  const extraCols = Object.entries(own).filter(([, s]) => s.type !== "object");
  const review = resultType?.properties[RESEARCH.review];
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const base = `/research/o/${slug}/p/${project.id}`;
  // a link to this page with the current filters, some of them changed (null removes one)
  const link = (change: Record<string, string | null>, path = base) => {
    const q = filterQuery(sp);
    for (const [k, v] of Object.entries(change)) if (v === null) q.delete(k); else q.set(k, v);
    return q.size ? `${path}?${q}` : path;
  };
  const query = (p: number) => link({ page: p > 1 ? String(p) : null });
  const sortBy = one("sort") || RESEARCH.score;
  const desc = one("order") !== "asc";
  const sortHead = (key: string, text: string) => (
    <Link href={link({ sort: key, order: sortBy === key && desc ? "asc" : null })} className="hover:text-mist hover:underline">
      {text}{sortBy === key ? (desc ? " ↓" : " ↑") : ""}
    </Link>
  );
  // the filters built from the schemas: a choice for enums and booleans, a range for numbers, the exact value otherwise
  const advanced = [
    ...Object.entries(resultType?.properties ?? {})
      .filter(([k, s]) => s.type !== "object" && s.type !== "timestamp" && ![RESEARCH.note, RESEARCH.review, RESEARCH.score, RESEARCH.assignee].includes(k as never))
      .map(([k, s]) => [k, s] as const),
    ...extraCols.filter(([, s]) => s.type !== "timestamp").map(([k, s]) => [`${RESEARCH.extra}.${k}`, s] as const),
  ];
  const advancedOn = advanced.some(([k]) => one(`f.${k}`) || one(`min.${k}`) || one(`max.${k}`));
  const filterInput = (k: string, s: PropertySpec) => {
    const title = label(s.label, locale, k.split(".").pop()!);
    if (s.enum || s.type === "boolean")
      return (
        <label key={k} className="block"><span className="text-xs text-dim">{title}</span>
          <select name={`f.${k}`} defaultValue={one(`f.${k}`)} className="mt-1">
            <option value="">{t.anyValue}</option>
            {(s.enum ?? [true, false]).map((v) => <option key={String(v)} value={String(v)}>{fieldText(s, v, locale)}</option>)}
          </select></label>
      );
    if (s.type === "number")
      return (
        <span key={k} className="flex items-end gap-1">
          <label className="block"><span className="text-xs text-dim">{title} ≥</span>
            <input name={`min.${k}`} defaultValue={one(`min.${k}`)} inputMode="decimal" className="mt-1 w-24" /></label>
          <label className="block"><span className="text-xs text-dim">≤</span>
            <input name={`max.${k}`} defaultValue={one(`max.${k}`)} inputMode="decimal" className="mt-1 w-24" /></label>
        </span>
      );
    return (
      <label key={k} className="block"><span className="text-xs text-dim">{title}</span>
        <input name={`f.${k}`} defaultValue={one(`f.${k}`)} inputMode={isNumber(s) ? "numeric" : undefined} className="mt-1 w-32" /></label>
    );
  };
  const queue = filterQuery(sp);
  queue.delete("review");
  const exportLink = (format: string) => link({ format }, `${base}/export`);

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
        <div className="mt-3"><Flash saved={sp.saved} error={sp.error} t={t} /></div>
        <form className="mt-3 text-sm">
          {one("sort") && <input type="hidden" name="sort" value={one("sort")} />}
          {one("order") && <input type="hidden" name="order" value={one("order")} />}
          <div className="flex flex-wrap items-end gap-3">
            <label className="block"><span className="text-xs text-dim">{t.searchResults}</span>
              <input name="q" type="search" defaultValue={one("q")} className="mt-1 w-48" /></label>
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
            {assignable && (
              <label className="flex items-center gap-2 pb-2 text-xs">
                <input type="checkbox" name="mine" value="1" defaultChecked={!!one("mine")} /> {t.assignedToMe}</label>
            )}
            <button className="btn">{t.filter}</button>
            <Link href={base} className="pb-2 text-xs text-dim hover:underline">{t.clearFilters}</Link>
          </div>
          {advanced.length > 0 && (
            <details open={advancedOn} className="mt-3">
              <summary className="cursor-pointer text-xs text-dim">{t.moreFilters}</summary>
              <div className="mt-2 flex flex-wrap items-end gap-3">{advanced.map(([k, s]) => filterInput(k, s))}</div>
            </details>
          )}
        </form>
        <div className="mt-3 flex flex-wrap gap-4 text-xs">
          <Link href={queue.size ? `${base}/review?${queue}` : `${base}/review`} className="text-frost hover:underline">{t.reviewQueue} →</Link>
          <a href={exportLink("csv")} className="text-frost hover:underline">{t.exportCsv}</a>
          <a href={exportLink("json")} className="text-frost hover:underline">{t.exportJson}</a>
        </div>
        {results.length ? (
          <form action={reviewMany}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="project" value={project.id} />
            <input type="hidden" name="back" value={query(page)} />
            {editor && (
              <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
                {review?.enum && (
                  <label className="block"><span className="text-xs text-dim">{t.setReview}</span>
                    <select name="review" defaultValue="" className="mt-1">
                      <option value="">{t.unchanged}</option>
                      {review.enum.map((v) => <option key={String(v)} value={String(v)}>{fieldText(review, v, locale)}</option>)}
                    </select></label>
                )}
                {assignable && (
                  <label className="block"><span className="text-xs text-dim">{t.setAssignee}</span>
                    <select name="assignee" defaultValue="" className="mt-1">
                      <option value="">{t.unchanged}</option>
                      <option value="-">{t.nobody}</option>
                      {members.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select></label>
                )}
                <SubmitButton pending={t.saving} className="btn">{t.applyToSelected}</SubmitButton>
              </div>
            )}
            <div className="card mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-dim">
                  <tr>
                    {editor && <th className="w-8 px-3 py-2"><CheckAll name="ids" label={t.selectAll} /></th>}
                    <th className="px-3 py-2">{sortHead("name", t.objectName)}</th>
                    {cols.map(([k, s]) => (
                      <th key={k} className="px-3 py-2">{isNumber(s) || s.type === "string" ? sortHead(k, label(s.label, locale, k)) : label(s.label, locale, k)}</th>
                    ))}
                    {extraCols.map(([k, s]) => (
                      <th key={`x.${k}`} className="px-3 py-2">
                        {isNumber(s) || s.type === "string" ? sortHead(`${RESEARCH.extra}.${k}`, label(s.label, locale, k)) : label(s.label, locale, k)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {results.map((r) => {
                    const extra = (r.properties[RESEARCH.extra] ?? {}) as Record<string, unknown>;
                    return (
                      <tr key={r.id}>
                        {editor && <td className="px-3 py-2"><input type="checkbox" name="ids" value={r.id} aria-label={r.name} /></td>}
                        <td className="px-3 py-2"><Link href={`/research/o/${slug}/r/${r.id}`} className="text-frost hover:underline">{r.name}</Link></td>
                        {cols.map(([k, s]) => <td key={k} className={isNumber(s) ? "num px-3 py-2" : "px-3 py-2"}>{fieldText(s, r.properties[k], locale)}</td>)}
                        {extraCols.map(([k, s]) => <td key={`x.${k}`} className={isNumber(s) ? "num px-3 py-2" : "px-3 py-2"}>{fieldText(s, extra[k], locale)}</td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </form>
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
