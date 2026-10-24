import Link from "next/link";
import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { listEvents } from "@/lib/engine/events";
import { fieldText, getEventType, label } from "@/lib/engine/registers";
import { countLinked, getObject, getObjectType, objectHistogram, objectPoints, searchObjects } from "@/lib/engine/custom-objects";
import { getSettings, num } from "@/lib/engine/settings";
import { canRecord } from "@/lib/engine/manual";
import type { PropertySpec } from "@/lib/engine/package";
import { filterQuery, projectFields, RESEARCH, resultFilters, shownColumns } from "@/lib/research";
import { CheckAll } from "@/components/check-all";
import { Flash } from "@/components/flash";
import { SubmitButton } from "@/components/submit-button";
import { Histogram, ResultScatter } from "@/components/research/charts";
import { deleteView, reviewMany, saveView } from "../../actions";
import { assignees, researchContext } from "../../context";
import { Outcome, runLabel } from "../../runs";

const isNumber = (s: PropertySpec) => s.type === "number" || s.type === "integer";

/**
 * A project: its properties, its run history and its results, searched, filtered on any of their
 * properties (the project's own fields too) and sorted by column, with batch review and assignment;
 * charts of the results matching the filters, the review funnel, a choice of columns and saved views.
 */
export default async function Project(props: PageProps<"/research/o/[slug]/p/[id]">) {
  const { slug, id } = await props.params;
  const sp = await props.searchParams;
  const { org, db, author } = await researchContext(slug);
  const { t, locale } = await getT();
  const [project, type, resultType, runType, viewType] = await Promise.all([
    getObject(db, id), getObjectType(db, RESEARCH.project), getObjectType(db, RESEARCH.result), getEventType(db, [], RESEARCH.run), getObjectType(db, RESEARCH.view),
  ]);
  if (!project || !type || project.type !== type.type) notFound();

  const pageSize = num(await getSettings(db.shared), "objects.page_size", 100);
  const own = projectFields(project);
  const assignable = !!resultType?.properties[RESEARCH.assignee];
  const { page, ...filters } = resultFilters(sp, project.id, { result: resultType?.properties, own, me: author.email });
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  // the numeric columns the charts can plot: the result's, then the project's own fields
  const numeric = [
    ...Object.entries(resultType?.properties ?? {}).filter(([, s]) => isNumber(s)).map(([k, s]) => [k, label(s.label, locale, k)] as const),
    ...Object.entries(own).filter(([, s]) => isNumber(s)).map(([k, s]) => [`${RESEARCH.extra}.${k}`, label(s.label, locale, k)] as const),
  ];
  const numericKeys = numeric.map(([k]) => k);
  const pick = (k: string, fallback: string | undefined) => (numericKeys.includes(one(k)) ? one(k) : fallback);
  const hist = pick("hist", numericKeys.includes(RESEARCH.score) ? RESEARCH.score : numericKeys[0]);
  const x = pick("x", hist);
  const y = pick("y", numericKeys.find((k) => k !== x));
  const [runs, notes, { objects: results, total }, histogram, scatter, byReview, views] = await Promise.all([
    listEvents(db, { types: [RESEARCH.run], objectId: project.id, recursive: false, limit: 50 }),
    listEvents(db, { types: [RESEARCH.labNote], objectId: project.id, recursive: false, limit: 3 }),
    resultType ? searchObjects(db, RESEARCH.result, { ...filters, limit: pageSize, offset: (page - 1) * pageSize }) : { objects: [], total: 0 },
    resultType && hist ? objectHistogram(db, RESEARCH.result, hist, filters, 24) : null,
    resultType && x && y && x !== y ? objectPoints(db, RESEARCH.result, x, y, filters, 1500) : null,
    resultType ? countLinked(db, RESEARCH.result, RESEARCH.link, RESEARCH.review) : [],
    viewType ? searchObjects(db, RESEARCH.view, { linkedTo: { key: RESEARCH.link, id: project.id }, order: { by: "name", desc: false }, limit: 50 }) : null,
  ]);

  const members = assignable ? await assignees(org.id) : [];
  const editor = canRecord(author.role);
  const shown = Object.entries(type.properties).filter(([k, s]) => s.type !== "object" && project.properties[k] !== undefined);
  const runCols = Object.entries(runType?.fields ?? {}).filter(([, s]) => s.type !== "object");
  // the result's own scalar properties, then the project's fields held in `extra`
  const cols = Object.entries(resultType?.properties ?? {}).filter(([k, s]) => s.type !== "object" && k !== RESEARCH.note);
  const extraCols = Object.entries(own).filter(([, s]) => s.type !== "object");
  const columns = [...cols.map(([k, s]) => [k, label(s.label, locale, k)] as const), ...extraCols.map(([k, s]) => [`${RESEARCH.extra}.${k}`, label(s.label, locale, k)] as const)];
  const visible = shownColumns(sp.cols, columns.map(([k]) => k));
  const review = resultType?.properties[RESEARCH.review];
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
  // the current filters as hidden inputs of a form that sets the others
  const keep = (...drop: string[]) =>
    [...filterQuery(sp)].filter(([k]) => !drop.includes(k)).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);
  const nameOf = (k: string) => numeric.find(([n]) => n === k)?.[1] ?? k;
  // a histogram's range is the score's min / max, or a field's min.<key> / max.<key>
  const [minKey, maxKey] = hist === RESEARCH.score ? ["min", "max"] : [`min.${hist}`, `max.${hist}`];
  const histQuery = filterQuery(sp);
  histQuery.delete(minKey);
  histQuery.delete(maxKey);
  const ranged = !!(one(minKey) || one(maxKey));
  // the review funnel over all the project's results: reviewed, then kept (interesting or sent), then sent
  const counts = Object.fromEntries(byReview.filter((r) => r.id === project.id).map((r) => [r.value ?? "", r.n]));
  const all = Object.values(counts).reduce((a, n) => a + n, 0);
  const states = (review?.enum ?? []).map(String);
  const funnel = states.includes("interesting") && states.includes("sent") && all > 0
    ? [
        { label: t.funnelTotal, n: all },
        { label: t.funnelReviewed, n: all - (counts[RESEARCH.pending] ?? 0) - (counts[""] ?? 0) },
        { label: `${fieldText(review, "interesting", locale)} + ${fieldText(review, "sent", locale)}`, n: (counts.interesting ?? 0) + (counts.sent ?? 0) },
        { label: fieldText(review, "sent", locale), n: counts.sent ?? 0 },
      ]
    : [];
  const current = filterQuery(sp).toString();

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
            <dd className="whitespace-pre-line break-words">{fieldText(s, project.properties[k], locale)}</dd>
          </div>
        ))}
      </dl>

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">{t.labNotes}</h2>
          <Link href={`${base}/notes`} className="text-xs text-frost hover:underline">{notes.length ? t.allNotes : t.writeNote} →</Link>
        </div>
        {notes.length > 0 && (
          <ul className="card mt-3 divide-y divide-line-soft text-sm">
            {notes.map((n) => (
              <li key={n.id} className="px-3 py-2">
                <p className="text-xs text-dim">{n.authorLabel ?? n.author ?? "—"} · {n.ts.toLocaleString(locale)}</p>
                <p className="mt-1 line-clamp-3 whitespace-pre-line break-words">{String(n.payload[RESEARCH.text] ?? "")}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium">{t.runs}</h2>
        {runs.length ? (
          <>
            {runs.length > 1 && (
              <form action={`${base}/compare`} className="mt-3 flex flex-wrap items-end gap-3 text-sm">
                {(["a", "b"] as const).map((k, i) => (
                  <label key={k} className="block"><span className="text-xs text-dim">{i ? t.compareWith : t.compareRun}</span>
                    <select name={k} defaultValue={String(runs[i === 0 ? 1 : 0].id)} className="mt-1 max-w-72">
                      {runs.map((e) => <option key={e.id} value={e.id}>{runLabel(e, locale)}</option>)}
                    </select></label>
                ))}
                <button className="btn">{t.compare}</button>
              </form>
            )}
            <div className="card mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-dim">
                  <tr><th className="px-3 py-2">{t.date}</th>{runCols.map(([k, s]) => <th key={k} className="px-3 py-2">{label(s.label, locale, k)}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {runs.map((e) => (
                    <tr key={e.id}>
                      <td className="num whitespace-nowrap px-3 py-2"><Link href={`${base}/run/${e.id}`} className="text-frost hover:underline">{e.ts.toLocaleString(locale)}</Link></td>
                      {runCols.map(([k, s]) => (
                        <td key={k} className="px-3 py-2">{k === RESEARCH.outcome ? <Outcome spec={s} value={e.payload[k]} locale={locale} /> : fieldText(s, e.payload[k], locale)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
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
          {keep(...[...filterQuery(sp).keys()].filter((k) => !["sort", "order", "cols", "hist", "x", "y"].includes(k)))}
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
        {views && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-dim">{t.savedViews}</span>
            {views.objects.map((v) => {
              const q = String(v.properties[RESEARCH.query] ?? "");
              return (
                <span key={v.id} className={`flex items-center gap-1 rounded-full border px-2.5 py-1 ${q === current ? "border-ice/60 text-ice" : "border-line text-mist"}`}>
                  <Link href={q ? `${base}?${q}` : base} className="hover:underline">{v.name}</Link>
                  {editor && (
                    <form action={deleteView}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="project" value={project.id} />
                      <input type="hidden" name="id" value={v.id} />
                      <button className="text-dim hover:text-alarm" aria-label={`${t.deleteView} ${v.name}`} title={t.deleteView}>×</button>
                    </form>
                  )}
                </span>
              );
            })}
            {!views.objects.length && <span className="text-dim">{t.noViews}</span>}
            {editor && current && (
              <form action={saveView} className="flex items-center gap-1">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="project" value={project.id} />
                <input type="hidden" name="query" value={current} />
                <input name="name" required maxLength={80} placeholder={t.viewName} aria-label={t.viewName} className="w-36 py-1 text-xs" />
                <button className="btn py-1 text-xs">{t.saveView}</button>
              </form>
            )}
          </div>
        )}
        {(histogram?.bins.length || funnel.length || scatter) ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {histogram && histogram.bins.length > 0 && hist && (
              <div className="card p-4">
                <form className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  {keep("hist", "page")}
                  <label className="flex items-center gap-2 text-dim">{t.distribution}
                    <select name="hist" defaultValue={hist} className="py-1 text-xs">
                      {numeric.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                    </select></label>
                  <button className="btn py-1 text-xs">{t.show}</button>
                  {ranged && <Link href={link({ [minKey]: null, [maxKey]: null })} className="text-dim hover:underline">{t.clearRange}</Link>}
                </form>
                <div className="mt-2">
                  <Histogram bins={histogram.bins} path={base} query={histQuery.toString()} minKey={minKey} maxKey={maxKey} locale={locale}
                    labels={{ count: t.resultsShown, range: t.dragToFilter }} />
                </div>
                <p className="mt-1 text-xs text-dim">{t.dragToFilter}</p>
              </div>
            )}
            {scatter && x && y && (
              <div className="card p-4">
                <form className="flex flex-wrap items-center gap-2 text-xs">
                  {keep("x", "y", "page")}
                  {([["x", x], ["y", y]] as const).map(([k, v]) => (
                    <label key={k} className="flex items-center gap-1 text-dim">{k.toUpperCase()}
                      <select name={k} defaultValue={v} className="py-1 text-xs">
                        {numeric.map(([n, l]) => <option key={n} value={n}>{l}</option>)}
                      </select></label>
                  ))}
                  <button className="btn py-1 text-xs">{t.show}</button>
                </form>
                <div className="mt-2">
                  <ResultScatter points={scatter.points} href={`/research/o/${slug}/r`} xLabel={nameOf(x)} yLabel={nameOf(y)} locale={locale} />
                </div>
                <p className="mt-1 text-xs text-dim">
                  {scatter.total > scatter.points.length ? `${t.pointsShown} ${scatter.points.length} / ${scatter.total}. ` : ""}{t.clickPoint}
                </p>
              </div>
            )}
            {funnel.length > 0 && (
              <div className="card p-4">
                <h3 className="text-xs text-dim">{t.reviewFunnel}</h3>
                <ol className="mt-3 space-y-2 text-xs">
                  {funnel.map((f) => (
                    <li key={f.label}>
                      <div className="flex justify-between gap-2"><span className="text-mist">{f.label}</span>
                        <span><span className="num text-frost">{f.n}</span> <span className="num text-dim">{Math.round((f.n / all) * 100)}%</span></span></div>
                      <div className="mt-1 h-2 rounded-sm bg-line-soft"><div className="h-2 rounded-sm bg-ice/80" style={{ width: `${(f.n / all) * 100}%` }} /></div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        ) : null}
        {columns.length > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-dim">{t.columns} <span className="num">{visible.size}/{columns.length}</span></summary>
            <form className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              {keep("cols", "page")}
              {columns.map(([k, n]) => (
                <label key={k} className="flex items-center gap-1.5"><input type="checkbox" name="cols" value={k} defaultChecked={visible.has(k)} /> {n}</label>
              ))}
              <button className="btn py-1 text-xs">{t.show}</button>
              {visible.size < columns.length && <Link href={link({ cols: null })} className="text-dim hover:underline">{t.allColumns}</Link>}
            </form>
            <p className="mt-1 text-dim">{t.columnsExportNote}</p>
          </details>
        )}
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
                    {cols.filter(([k]) => visible.has(k)).map(([k, s]) => (
                      <th key={k} className="px-3 py-2">{isNumber(s) || s.type === "string" ? sortHead(k, label(s.label, locale, k)) : label(s.label, locale, k)}</th>
                    ))}
                    {extraCols.filter(([k]) => visible.has(`${RESEARCH.extra}.${k}`)).map(([k, s]) => (
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
                        {cols.filter(([k]) => visible.has(k)).map(([k, s]) => (
                          <td key={k} className={isNumber(s) ? "num px-3 py-2" : "px-3 py-2"}>
                            {k === RESEARCH.runRef && r.properties[k] ? (
                              <Link href={`${base}/run/${Number(r.properties[k])}`} className="text-frost hover:underline">#{String(r.properties[k])}</Link>
                            ) : fieldText(s, r.properties[k], locale)}
                          </td>
                        ))}
                        {extraCols.filter(([k]) => visible.has(`${RESEARCH.extra}.${k}`)).map(([k, s]) => <td key={`x.${k}`} className={isNumber(s) ? "num px-3 py-2" : "px-3 py-2"}>{fieldText(s, extra[k], locale)}</td>)}
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
