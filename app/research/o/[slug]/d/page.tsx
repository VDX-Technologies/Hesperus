import Link from "next/link";
import { getT } from "@/lib/i18n";
import { listEvents } from "@/lib/engine/events";
import { fieldText } from "@/lib/engine/registers";
import { getObjectType, listObjects } from "@/lib/engine/custom-objects";
import { RESEARCH } from "@/lib/research";
import { researchContext } from "../context";

export default async function Datasets(props: PageProps<"/research/o/[slug]/d">) {
  const { slug } = await props.params;
  const { db } = await researchContext(slug);
  const { t, locale } = await getT();
  const type = await getObjectType(db, RESEARCH.dataset);
  const datasets = type ? await listObjects(db, RESEARCH.dataset) : [];
  const last = await Promise.all(datasets.map((d) => listEvents(db, { types: [RESEARCH.run], objectId: d.id, recursive: false, limit: 1 })));
  const source = type?.properties.source;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.datasets}</h1>
        {type && <Link href={`/research/o/${slug}/objects/${encodeURIComponent(RESEARCH.dataset)}#new`} className="text-xs text-frost hover:underline">+ {t.newObject}</Link>}
      </div>
      {datasets.length ? (
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {datasets.map((d, i) => (
            <li key={d.id}>
              <Link href={`/research/o/${slug}/d/${d.id}`} className="card block p-4 text-sm hover:border-frost">
                <span className="font-medium">{d.name}</span>
                {source && d.properties.source !== undefined && <div className="mt-2 text-xs text-dim">{fieldText(source, d.properties.source, locale)}</div>}
                <div className="mt-1 text-xs text-mist">{t.lastRun}: {last[i][0] ? last[i][0].ts.toLocaleDateString(locale) : t.never}</div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-6 text-sm text-dim">{t.noDatasets}</p>
      )}
    </div>
  );
}
