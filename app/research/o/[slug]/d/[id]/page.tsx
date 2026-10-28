import Link from "next/link";
import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { listEvents } from "@/lib/engine/events";
import { fieldText, getEventType, label } from "@/lib/engine/registers";
import { getObject, getObjectType } from "@/lib/engine/custom-objects";
import { RESEARCH } from "@/lib/research";
import { researchContext } from "../../context";
import { Outcome } from "../../runs";

const web = (v: unknown) => typeof v === "string" && /^https?:\/\//i.test(v);

export default async function Dataset(props: PageProps<"/research/o/[slug]/d/[id]">) {
  const { slug, id } = await props.params;
  const { db } = await researchContext(slug);
  const { t, locale } = await getT();
  const [dataset, type, runType] = await Promise.all([getObject(db, id), getObjectType(db, RESEARCH.dataset), getEventType(db, [], RESEARCH.run)]);
  if (!dataset || !type || dataset.type !== type.type) notFound();
  const runs = await listEvents(db, { types: [RESEARCH.run], objectId: dataset.id, recursive: false, limit: 200 });
  const projects = new Map((await Promise.all([...new Set(runs.map((r) => r.objectIds[0]))].map((p) => getObject(db, p)))).filter((p) => !!p).map((p) => [p.id, p]));
  const shown = Object.entries(type.properties).filter(([k, s]) => s.type !== "object" && dataset.properties[k] !== undefined);
  const outcome = runType?.fields[RESEARCH.outcome];

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{dataset.name}</h1>
        <div className="flex gap-4 text-xs">
          <Link href={`/research/o/${slug}/objects/${encodeURIComponent(RESEARCH.dataset)}?edit=${dataset.id}`} className="text-frost hover:underline">{t.edit}</Link>
          <Link href={`/research/o/${slug}/d`} className="text-dim hover:underline">← {t.datasets}</Link>
        </div>
      </div>
      {shown.length > 0 && (
        <dl className="card mt-4 grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2">
          {shown.map(([k, s]) => (
            <div key={k}>
              <dt className="text-xs text-dim">{label(s.label, locale, k)}</dt>
              <dd className="whitespace-pre-line break-words">
                {web(dataset.properties[k])
                  ? <a href={String(dataset.properties[k])} target="_blank" rel="noopener noreferrer" className="text-frost hover:underline">{String(dataset.properties[k])} ↗</a>
                  : fieldText(s, dataset.properties[k], locale)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-medium">{t.usedByRuns} <span className="num text-dim">{runs.length}</span></h2>
        {runs.length ? (
          <div className="card mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-dim">
                <tr><th className="px-3 py-2">{t.date}</th><th className="px-3 py-2">{t.project}</th><th className="px-3 py-2">{label(runType?.fields.commit?.label, locale, "commit")}</th><th className="px-3 py-2">{label(outcome?.label, locale, RESEARCH.outcome)}</th></tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {runs.map((r) => {
                  const p = projects.get(r.objectIds[0]);
                  return (
                    <tr key={r.id}>
                      <td className="num whitespace-nowrap px-3 py-2">
                        {p ? <Link href={`/research/o/${slug}/p/${p.id}/run/${r.id}`} className="text-frost hover:underline">{r.ts.toLocaleString(locale)}</Link> : r.ts.toLocaleString(locale)}
                      </td>
                      <td className="px-3 py-2">{p ? <Link href={`/research/o/${slug}/p/${p.id}`} className="hover:underline">{p.name}</Link> : "—"}</td>
                      <td className="num px-3 py-2">{String(r.payload.commit ?? "—").slice(0, 10)}</td>
                      <td className="px-3 py-2"><Outcome spec={outcome} value={r.payload[RESEARCH.outcome]} locale={locale} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-dim">{t.noRuns}</p>
        )}
      </section>
    </div>
  );
}
