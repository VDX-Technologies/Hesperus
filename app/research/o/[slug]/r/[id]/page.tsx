import Link from "next/link";
import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { listAudit } from "@/lib/engine/audit";
import { canRecord } from "@/lib/engine/manual";
import { fieldText, label } from "@/lib/engine/registers";
import { getObject, getObjectType, objectDocuments } from "@/lib/engine/custom-objects";
import { ActivityList } from "@/components/activity-list";
import { Flash } from "@/components/flash";
import { inlineImage, projectFields, RESEARCH } from "@/lib/research";
import { researchContext } from "../../context";
import { reviewResult } from "../../actions";

/** A result: its properties, its attachments (images previewed), its review and its history. */
export default async function Result(props: PageProps<"/research/o/[slug]/r/[id]">) {
  const { slug, id } = await props.params;
  const { saved, error } = await props.searchParams;
  const { db, author } = await researchContext(slug);
  const { t, locale } = await getT();
  const [result, type] = await Promise.all([getObject(db, id), getObjectType(db, RESEARCH.result)]);
  if (!result || !type || result.type !== type.type) notFound();
  const projectId = result.links[RESEARCH.link];
  const [project, docs, history] = await Promise.all([
    projectId ? getObject(db, projectId) : null,
    objectDocuments(db, result.id),
    listAudit(db, { objectId: result.id, limit: 50 }),
  ]);

  const editable = new Set<string>([RESEARCH.review, RESEARCH.note]);
  const shown = Object.entries(type.properties).filter(([k, s]) => s.type !== "object" && !editable.has(k) && result.properties[k] !== undefined);
  const extra = (result.properties[RESEARCH.extra] ?? {}) as Record<string, unknown>;
  const own = project ? projectFields(project) : {};
  // the project's fields first, in its order, then anything else the pipeline sent
  const extraRows = [...Object.entries(own).map(([k, s]) => [k, s] as const), ...Object.keys(extra).filter((k) => !own[k]).map((k) => [k, undefined] as const)]
    .filter(([k]) => extra[k] !== undefined);
  const review = type.properties[RESEARCH.review];
  const note = type.properties[RESEARCH.note];
  const images = docs.filter((d) => inlineImage(d.contentType));
  const files = docs.filter((d) => !inlineImage(d.contentType));
  const doc = (d: { id: string }) => `/research/o/${slug}/doc/${d.id}`;

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{result.name}</h1>
        {project && <Link href={`/research/o/${slug}/p/${project.id}`} className="text-xs text-dim hover:underline">← {project.name}</Link>}
      </div>
      <div className="mt-4"><Flash saved={saved} error={error} t={t} /></div>

      <div className="mt-2 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <dl className="card grid content-start gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2">
          {result.externalId && (
            <div><dt className="text-xs text-dim">{t.externalId}</dt><dd className="num break-words">{result.externalId}</dd></div>
          )}
          {shown.map(([k, s]) => (
            <div key={k}><dt className="text-xs text-dim">{label(s.label, locale, k)}</dt><dd className="break-words">{fieldText(s, result.properties[k], locale)}</dd></div>
          ))}
          {extraRows.map(([k, s]) => (
            <div key={`x.${k}`}>
              <dt className="text-xs text-dim">{label(s?.label, locale, k)}</dt>
              <dd className="break-words">{s ? fieldText(s, extra[k], locale) : typeof extra[k] === "object" ? JSON.stringify(extra[k]) : String(extra[k])}</dd>
            </div>
          ))}
        </dl>

        <form action={reviewResult} className="card space-y-3 p-4 text-sm">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="id" value={result.id} />
          <h2 className="font-medium">{t.review}</h2>
          {review?.enum && (
            <label className="block"><span className="text-xs text-dim">{label(review.label, locale, RESEARCH.review)}</span>
              <select name="review" defaultValue={String(result.properties[RESEARCH.review] ?? "")} className="mt-1 w-full" disabled={!canRecord(author.role)}>
                {review.enum.map((v) => <option key={String(v)} value={String(v)}>{fieldText(review, v, locale)}</option>)}
              </select></label>
          )}
          {note && (
            <label className="block"><span className="text-xs text-dim">{label(note.label, locale, RESEARCH.note)}</span>
              <textarea name="note" rows={5} defaultValue={String(result.properties[RESEARCH.note] ?? "")} className="mt-1 w-full" disabled={!canRecord(author.role)} /></label>
          )}
          {canRecord(author.role) && <button className="btn">{t.saveReview}</button>}
        </form>
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-medium">{t.attachments}</h2>
        {docs.length ? (
          <>
            {images.length > 0 && (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {images.map((d) => (
                  <figure key={d.id} className="card p-2">
                    <a href={doc(d)} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element -- private, tenant-checked bytes: no image optimizer */}
                      <img src={doc(d)} alt={d.filename ?? ""} loading="lazy" className="w-full rounded bg-white" />
                    </a>
                    <figcaption className="mt-1 truncate text-xs text-dim">{d.filename}</figcaption>
                  </figure>
                ))}
              </div>
            )}
            {files.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {files.map((d) => (
                  <li key={d.id}>
                    <a href={doc(d)} className="text-frost hover:underline">{d.filename ?? d.id}</a>
                    <span className="ml-2 text-xs text-dim">{d.contentType} · <span className="num">{Math.ceil((d.size ?? 0) / 1024)}</span> KB</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="mt-3 text-sm text-dim">{t.noAttachments}</p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium">{t.objectHistory}</h2>
        <ActivityList entries={history} t={t} locale={locale} />
      </section>
    </div>
  );
}
