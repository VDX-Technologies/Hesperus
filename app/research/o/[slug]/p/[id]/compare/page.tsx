import Link from "next/link";
import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { getEvent, type EventRow } from "@/lib/engine/events";
import { fieldText, getEventType, label } from "@/lib/engine/registers";
import { getObject, getObjectType, searchObjects } from "@/lib/engine/custom-objects";
import { paramDiff, RESEARCH } from "@/lib/research";
import { researchContext } from "../../../context";
import { Outcome } from "../../../runs";

const STATE: Record<string, string> = { changed: "text-warn", onlyA: "text-alarm", onlyB: "text-ok", same: "text-dim" };
const shown = (v: unknown) => (v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v));

export default async function Compare(props: PageProps<"/research/o/[slug]/p/[id]/compare">) {
  const { slug, id } = await props.params;
  const sp = await props.searchParams;
  const { db } = await researchContext(slug);
  const { t, locale } = await getT();
  const ids = [sp.a, sp.b].map((v) => Number(typeof v === "string" ? v : NaN));
  if (!ids.every((n) => Number.isSafeInteger(n) && n > 0)) notFound();
  const [project, a, b, runType, resultType] = await Promise.all([
    getObject(db, id), getEvent(db, ids[0]), getEvent(db, ids[1]), getEventType(db, [], RESEARCH.run), getObjectType(db, RESEARCH.result),
  ]);
  if (!project || project.type !== RESEARCH.project) notFound();
  const runs = [a, b].filter((e): e is EventRow => !!e && e.type === RESEARCH.run && e.objectIds[0] === project.id);
  if (runs.length !== 2) notFound();

  const base = `/research/o/${slug}/p/${project.id}`;
  const fields = Object.entries(runType?.fields ?? {});
  const scalars = fields.filter(([, s]) => s.type !== "object");
  const objects = fields.filter(([, s]) => s.type === "object");
  const review = resultType?.properties[RESEARCH.review];
  const values = [undefined, ...(review?.enum ?? [])];
  const counts = await Promise.all(runs.map((r) => Promise.all(values.map(async (v) => (await searchObjects(db, RESEARCH.result, {
    linkedTo: { key: RESEARCH.link, id: project.id },
    where: { [RESEARCH.runRef]: r.id, ...(v === undefined ? {} : { [RESEARCH.review]: v }) },
    limit: 0,
  })).total))));

  const head = (
    <tr>
      <th className="px-3 py-2" />
      {runs.map((r) => (
        <th key={r.id} className="px-3 py-2">
          <Link href={`${base}/run/${r.id}`} className="text-frost hover:underline">#{r.id}</Link>
          <span className="ml-2 font-normal">{r.ts.toLocaleString(locale)}</span>
        </th>
      ))}
    </tr>
  );

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.compareRuns}</h1>
        <Link href={base} className="text-xs text-dim hover:underline">← {project.name}</Link>
      </div>

      <div className="card mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-dim">{head}</thead>
          <tbody className="divide-y divide-line-soft">
            {scalars.map(([k, s]) => (
              <tr key={k} className={fieldText(s, runs[0].payload[k], locale) !== fieldText(s, runs[1].payload[k], locale) ? "" : "text-dim"}>
                <td className="px-3 py-2 text-xs text-dim">{label(s.label, locale, k)}</td>
                {runs.map((r) => (
                  <td key={r.id} className="num px-3 py-2">{k === RESEARCH.outcome ? <Outcome spec={s} value={r.payload[k]} locale={locale} /> : fieldText(s, r.payload[k], locale)}</td>
                ))}
              </tr>
            ))}
            <tr>
              <td className="px-3 py-2 text-xs text-dim">{t.results}</td>
              {counts.map((c, i) => <td key={i} className="num px-3 py-2">{c[0]}</td>)}
            </tr>
            {review && values.slice(1).map((v, j) => (
              <tr key={String(v)}>
                <td className="px-3 py-2 pl-6 text-xs text-dim">{fieldText(review, v, locale)}</td>
                {counts.map((c, i) => <td key={i} className="num px-3 py-2">{c[j + 1]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {objects.map(([k, s]) => {
        const rows = paramDiff(runs[0].payload[k], runs[1].payload[k]);
        return (
          <section key={k} className="mt-6">
            <h2 className="text-sm font-medium">{label(s.label, locale, k)}</h2>
            {rows.length ? (
              <div className="card mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-dim">{head}</thead>
                  <tbody className="divide-y divide-line-soft">
                    {rows.map((r) => (
                      <tr key={r.key} className={r.state === "same" ? "text-dim" : ""}>
                        <td className={`num px-3 py-2 text-xs ${STATE[r.state]}`}>{r.key}</td>
                        <td className="num break-all px-3 py-2">{shown(r.a)}</td>
                        <td className="num break-all px-3 py-2">{shown(r.b)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-3 text-sm text-dim">{t.noParams}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
