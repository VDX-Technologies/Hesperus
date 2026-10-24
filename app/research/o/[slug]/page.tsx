import Link from "next/link";
import { getT } from "@/lib/i18n";
import { listEvents } from "@/lib/engine/events";
import { fieldText, getEventType } from "@/lib/engine/registers";
import { countLinked, getObjectType, listObjects } from "@/lib/engine/custom-objects";
import { RESEARCH } from "@/lib/research";
import { researchContext } from "./context";

/** The projects with their stage, how many results they have (and how many wait for a review) and their last run. */
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
  const [projects, counts] = await Promise.all([
    listObjects(db, RESEARCH.project),
    resultType ? countLinked(db, RESEARCH.result, RESEARCH.link, RESEARCH.review) : [],
  ]);
  const runs = await Promise.all(projects.map((p) => listEvents(db, { types: [RESEARCH.run], objectId: p.id, recursive: false, limit: 1 })));
  const total = (id: string, review?: string) => counts.filter((c) => c.id === id && (!review || c.value === review)).reduce((n, c) => n + c.n, 0);
  const stage = type.properties[RESEARCH.stage];
  const outcome = (e: (typeof runs)[number][number]) => fieldText(runType?.fields[RESEARCH.outcome], e.payload[RESEARCH.outcome], locale);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.projects}</h1>
        <Link href={`/research/o/${slug}/objects/${encodeURIComponent(RESEARCH.project)}#new`} className="text-xs text-frost hover:underline">+ {t.newObject}</Link>
      </div>
      {projects.length ? (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p, i) => {
            const last = runs[i][0];
            return (
              <li key={p.id}>
                <Link href={`/research/o/${slug}/p/${p.id}`} className="card block p-4 text-sm hover:border-frost">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-dim">{fieldText(stage, p.properties[RESEARCH.stage], locale)}</span>
                  </div>
                  <div className="mt-2 text-xs text-dim">
                    <span className="num">{total(p.id)}</span> {t.results.toLowerCase()} · <span className="num">{total(p.id, RESEARCH.pending)}</span> {t.toReviewCount}
                  </div>
                  <div className="mt-1 text-xs text-mist">
                    {t.lastRun}: {last ? `${last.ts.toLocaleDateString(locale)} · ${outcome(last)}` : t.never}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-dim">{t.noProjects}</p>
      )}
    </div>
  );
}
