import Link from "next/link";
import { cookies } from "next/headers";
import { getT } from "@/lib/i18n";
import { listEvents } from "@/lib/engine/events";
import { fieldText, getEventType, label } from "@/lib/engine/registers";
import { countLinked, getObjectType, listObjects, objectHistogram } from "@/lib/engine/custom-objects";
import { lastVisit, RESEARCH, VISIT_COOKIE } from "@/lib/research";
import { VisitMarker } from "@/components/research/visit";
import { researchContext } from "./context";
import { Outcome } from "./runs";

/**
 * The research home: what waits for a review, what arrived since the last visit and which runs
 * failed in the last day; then the projects, each with how its scores spread, how far its review
 * got and its last run; then the latest runs, lab notes and comments.
 */
export default async function Projects(props: PageProps<"/research/o/[slug]">) {
  const { slug } = await props.params;
  const { db } = await researchContext(slug);
  const { t, locale } = await getT();
  const [type, resultType, runType] = await Promise.all([getObjectType(db, RESEARCH.project), getObjectType(db, RESEARCH.result), getEventType(db, [], RESEARCH.run)]);
  if (!type) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t.projects}</h1>
        <p className="mt-6 text-sm text-dim">{t.noProjectType}</p>
        <Link href={`/research/o/${slug}/types`} className="btn mt-4 inline-block">{t.schemaEditor}</Link>
      </div>
    );
  }
  // the visit cookie is moved on by <VisitMarker>: a page can't set cookies while it renders
  const now = new Date();
  const visit = lastVisit((await cookies()).get(VISIT_COOKIE)?.value, now.getTime());
  const scored = resultType?.properties[RESEARCH.score];
  const [projects, counts, fresh, failed, feed] = await Promise.all([
    listObjects(db, RESEARCH.project),
    resultType ? countLinked(db, RESEARCH.result, RESEARCH.link, RESEARCH.review) : [],
    resultType && visit.since ? countLinked(db, RESEARCH.result, RESEARCH.link, undefined, visit.since) : [],
    runType ? listEvents(db, { types: [RESEARCH.run], from: new Date(now.getTime() - 864e5), payload: { [RESEARCH.outcome]: "failed" }, limit: 1000 }) : [],
    listEvents(db, { types: [RESEARCH.run, RESEARCH.labNote, RESEARCH.comment], limit: 12 }),
  ]);
  const [runs, spreads] = await Promise.all([
    Promise.all(projects.map((p) => listEvents(db, { types: [RESEARCH.run], objectId: p.id, recursive: false, limit: 1 }))),
    Promise.all(projects.map((p) => (scored ? objectHistogram(db, RESEARCH.result, RESEARCH.score, { linkedTo: { key: RESEARCH.link, id: p.id } }, 16) : null))),
  ]);
  const total = (id: string, review?: string) => counts.filter((c) => c.id === id && (!review || c.value === review)).reduce((n, c) => n + c.n, 0);
  const sum = (rows: { n: number }[]) => rows.reduce((n, r) => n + r.n, 0);
  const stage = type.properties[RESEARCH.stage];
  const review = resultType?.properties[RESEARCH.review];
  const states = (review?.enum ?? []).map(String);
  const ids = new Set(projects.map((p) => p.id));
  const names = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  const base = `/research/o/${slug}`;

  const tiles = [
    { label: t.toReview, value: sum(counts.filter((c) => c.value === RESEARCH.pending)), tone: "text-frost" },
    { label: t.newSinceVisit, value: visit.since ? sum(fresh) : null, tone: "text-frost", hint: visit.since?.toLocaleString(locale) },
    { label: t.failedRuns24h, value: runType ? failed.length : null, tone: failed.length ? "text-alarm" : "text-frost" },
  ];
  // where a feed entry leads: a run to its page, a lab note to the notebook, a comment to its result
  const target = (e: (typeof feed)[number]) => {
    const project = e.objectIds.find((id) => ids.has(id));
    if (e.type === RESEARCH.run) return project ? `${base}/p/${project}/run/${e.id}` : null;
    if (e.type === RESEARCH.labNote) return project ? `${base}/p/${project}/notes` : null;
    const result = e.objectIds.find((id) => !ids.has(id));
    return result ? `${base}/r/${result}` : null;
  };
  const kind = (type: string) => (type === RESEARCH.run ? t.run : type === RESEARCH.labNote ? t.labNotes : t.comments);
  const summary = (e: (typeof feed)[number]) =>
    e.type === RESEARCH.run ? <Outcome spec={runType?.fields[RESEARCH.outcome]} value={e.payload[RESEARCH.outcome]} locale={locale} /> : String(e.payload[RESEARCH.text] ?? "").slice(0, 140);

  return (
    <div>
      {visit.next && <VisitMarker slug={slug} />}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.projects}</h1>
        <Link href={`${base}/objects/${encodeURIComponent(RESEARCH.project)}#new`} className="text-xs text-frost hover:underline">+ {t.newObject}</Link>
      </div>

      <dl className="mt-6 grid gap-3 sm:grid-cols-3">
        {tiles.map((k) => (
          <div key={k.label} className="card p-4">
            <dt className="text-xs text-dim">{k.label}</dt>
            <dd className={`num mt-1 text-2xl font-semibold ${k.tone}`}>{k.value ?? "—"}</dd>
            {k.hint && <p className="mt-1 text-xs text-dim">{k.hint}</p>}
          </div>
        ))}
      </dl>

      {projects.length ? (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p, i) => {
            const last = runs[i][0];
            const spread = spreads[i];
            const peak = Math.max(1, ...(spread?.bins.map((b) => b.n) ?? []));
            const all = total(p.id);
            const parts = states.map((v) => ({ v, n: total(p.id, v) })).filter((s) => s.n > 0);
            return (
              <li key={p.id}>
                <Link href={`${base}/p/${p.id}`} className="card block p-4 text-sm hover:border-frost">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-dim">{fieldText(stage, p.properties[RESEARCH.stage], locale)}</span>
                  </div>
                  <div className="mt-2 text-xs text-dim">
                    <span className="num">{all}</span> {t.results.toLowerCase()} · <span className="num">{total(p.id, RESEARCH.pending)}</span> {t.toReviewCount}
                  </div>
                  {spread && spread.bins.length > 0 && (
                    <div className="mt-3" aria-label={`${t.distribution} ${label(scored?.label, locale, RESEARCH.score)}`}>
                      <div className="flex h-10 items-end gap-px">
                        {spread.bins.map((b) => (
                          <div key={b.lo} className="flex-1 rounded-t-sm bg-ice/80" style={{ height: `${Math.max(b.n ? 6 : 0, (b.n / peak) * 100)}%` }}
                            title={`${b.lo.toLocaleString(locale, { maximumSignificantDigits: 3 })} – ${b.hi.toLocaleString(locale, { maximumSignificantDigits: 3 })}: ${b.n}`} />
                        ))}
                      </div>
                      <div className="num mt-0.5 flex justify-between text-[10px] text-dim">
                        <span>{spread.min?.toLocaleString(locale, { maximumSignificantDigits: 3 })}</span>
                        <span>{spread.max?.toLocaleString(locale, { maximumSignificantDigits: 3 })}</span>
                      </div>
                    </div>
                  )}
                  {all > 0 && parts.length > 0 && (
                    <div className="mt-3">
                      <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-sm">
                        {parts.map((s, j) => (
                          <div key={s.v} className="bg-ice" style={{ width: `${(s.n / all) * 100}%`, opacity: s.v === RESEARCH.pending ? 0.25 : 0.9 - j * 0.15 }}
                            title={`${fieldText(review, s.v, locale)}: ${s.n}`} />
                        ))}
                      </div>
                      <p className="mt-1 text-[11px] text-dim">
                        {parts.map((s) => `${fieldText(review, s.v, locale)} ${s.n}`).join(" · ")}
                      </p>
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-mist">
                    {t.lastRun}: {last ? <>{last.ts.toLocaleDateString(locale)} <Outcome spec={runType?.fields[RESEARCH.outcome]} value={last.payload[RESEARCH.outcome]} locale={locale} /></> : t.never}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-dim">{t.noProjects}</p>
      )}

      {feed.length > 0 && (
        <section className="mt-8">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">{t.recentActivity}</h2>
            <Link href={`${base}/activity`} className="text-xs text-frost hover:underline">{t.allActivity} →</Link>
          </div>
          <ul className="card mt-3 divide-y divide-line-soft text-sm">
            {feed.map((e) => {
              const href = target(e);
              const project = e.objectIds.find((id) => ids.has(id));
              const body = (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-dim">
                    <span><span className="text-mist">{kind(e.type)}</span>{project ? ` · ${names[project]}` : ""}</span>
                    <span>{e.authorLabel ?? e.author ?? "—"} · {e.ts.toLocaleString(locale)}</span>
                  </div>
                  <div className="mt-1 truncate text-mist">{summary(e)}</div>
                </>
              );
              return <li key={e.id}>{href ? <Link href={href} className="block px-4 py-2.5 hover:bg-ink-800">{body}</Link> : <div className="px-4 py-2.5">{body}</div>}</li>;
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
