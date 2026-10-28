import Link from "next/link";
import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { getEvent } from "@/lib/engine/events";
import { fieldText, getEventType, label } from "@/lib/engine/registers";
import { getObject, getObjectType, searchObjects } from "@/lib/engine/custom-objects";
import { RESEARCH } from "@/lib/research";
import { researchContext } from "../../../../context";
import { Outcome } from "../../../../runs";

export default async function Run(props: PageProps<"/research/o/[slug]/p/[id]/run/[eventId]">) {
  const { slug, id, eventId } = await props.params;
  const { db } = await researchContext(slug);
  const { t, locale } = await getT();
  const runId = Number(eventId);
  if (!Number.isSafeInteger(runId) || runId <= 0) notFound();
  const [project, run, runType, resultType] = await Promise.all([
    getObject(db, id), getEvent(db, runId), getEventType(db, [], RESEARCH.run), getObjectType(db, RESEARCH.result),
  ]);
  if (!project || project.type !== RESEARCH.project || !run || run.type !== RESEARCH.run || run.objectIds[0] !== project.id) notFound();

  const base = `/research/o/${slug}/p/${project.id}`;
  const fields = Object.entries(runType?.fields ?? {});
  const scalars = fields.filter(([k, s]) => s.type !== "object" && run.payload[k] !== undefined);
  const objects = fields.filter(([k, s]) => s.type === "object" && run.payload[k] !== undefined);
  const review = resultType?.properties[RESEARCH.review];
  const where = { [RESEARCH.runRef]: run.id };
  const [datasets, { total }, counts] = await Promise.all([
    Promise.all(run.objectIds.slice(1).map((d) => getObject(db, d))),
    searchObjects(db, RESEARCH.result, { linkedTo: { key: RESEARCH.link, id: project.id }, where, limit: 0 }),
    Promise.all((review?.enum ?? []).map(async (v) => ({
      value: String(v),
      n: (await searchObjects(db, RESEARCH.result, { linkedTo: { key: RESEARCH.link, id: project.id }, where: { ...where, [RESEARCH.review]: v }, limit: 0 })).total,
    }))),
  ]);
  const results = `${base}?f.${RESEARCH.runRef}=${run.id}`;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.run} <span className="num text-dim">#{run.id}</span></h1>
        <Link href={base} className="text-xs text-dim hover:underline">← {project.name}</Link>
      </div>
      <p className="mt-1 text-xs text-dim">{run.ts.toLocaleString(locale)} · {run.authorLabel ?? run.author ?? "—"}</p>

      <dl className="card mt-4 grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-3">
        {scalars.map(([k, s]) => (
          <div key={k}>
            <dt className="text-xs text-dim">{label(s.label, locale, k)}</dt>
            <dd className="break-words">{k === RESEARCH.outcome ? <Outcome spec={s} value={run.payload[k]} locale={locale} /> : fieldText(s, run.payload[k], locale)}</dd>
          </div>
        ))}
      </dl>

      {objects.map(([k, s]) => (
        <section key={k} className="mt-6">
          <h2 className="text-sm font-medium">{label(s.label, locale, k)}</h2>
          <pre className="card num mt-3 overflow-x-auto p-4 text-xs">{JSON.stringify(run.payload[k], null, 2)}</pre>
        </section>
      ))}

      <section className="mt-6">
        <h2 className="text-sm font-medium">{t.datasets}</h2>
        {datasets.some(Boolean) ? (
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {datasets.map((d) => d && (
              <li key={d.id}><Link href={`/research/o/${slug}/d/${d.id}`} className="card inline-block px-3 py-1.5 text-frost hover:underline">{d.name}</Link></li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-dim">{t.noDatasets}</p>
        )}
      </section>

      <section className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">{t.results} <span className="num text-dim">{total}</span></h2>
          {total > 0 && <Link href={results} className="text-xs text-frost hover:underline">{t.showResults} →</Link>}
        </div>
        {review && total > 0 && (
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
            {counts.map((c) => (
              <li key={c.value}>
                <Link href={`${results}&review=${encodeURIComponent(c.value)}`} className="card block p-3 hover:border-frost/40">
                  <span className="text-xs text-dim">{fieldText(review, c.value, locale)}</span>
                  <span className="num mt-1 block text-lg">{c.n}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
