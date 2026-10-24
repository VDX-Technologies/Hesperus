import Link from "next/link";
import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { listAudit } from "@/lib/engine/audit";
import { canRecord } from "@/lib/engine/manual";
import { fieldText, label } from "@/lib/engine/registers";
import { getObject, getObjectType, objectDocuments } from "@/lib/engine/custom-objects";
import { listEvents, type EventRow } from "@/lib/engine/events";
import { ActivityList } from "@/components/activity-list";
import { Flash } from "@/components/flash";
import { commentThreads, expandLinks, projectFields, RESEARCH } from "@/lib/research";
import { researchContext } from "../../context";
import { addComment, reviewResult } from "../../actions";
import { Attachments, OutsideLinks } from "../../attachments";

/**
 * A result: its properties and outside links, the run that produced it, its attachments
 * (previewed), its review, the comments on it in threads and its history.
 */
export default async function Result(props: PageProps<"/research/o/[slug]/r/[id]">) {
  const { slug, id } = await props.params;
  const { saved, error } = await props.searchParams;
  const { db, author } = await researchContext(slug);
  const { t, locale } = await getT();
  const [result, type] = await Promise.all([getObject(db, id), getObjectType(db, RESEARCH.result)]);
  if (!result || !type || result.type !== type.type) notFound();
  const projectId = result.links[RESEARCH.link];
  const [project, docs, history, comments] = await Promise.all([
    projectId ? getObject(db, projectId) : null,
    objectDocuments(db, result.id),
    listAudit(db, { objectId: result.id, limit: 50 }),
    listEvents(db, { types: [RESEARCH.comment], objectId: result.id, recursive: false, limit: 500 }),
  ]);
  const run = Number(result.properties[RESEARCH.runRef]) || null;

  const editable = new Set<string>([RESEARCH.review, RESEARCH.note]);
  const shown = Object.entries(type.properties).filter(([k, s]) => s.type !== "object" && !editable.has(k) && result.properties[k] !== undefined);
  const extra = (result.properties[RESEARCH.extra] ?? {}) as Record<string, unknown>;
  const own = project ? projectFields(project) : {};
  // the project's fields first, in its order, then anything else the pipeline sent
  const extraRows = [...Object.entries(own).map(([k, s]) => [k, s] as const), ...Object.keys(extra).filter((k) => !own[k]).map((k) => [k, undefined] as const)]
    .filter(([k]) => extra[k] !== undefined);
  const review = type.properties[RESEARCH.review];
  const note = type.properties[RESEARCH.note];
  const links = project ? expandLinks(project.properties[RESEARCH.links], result) : [];
  const threads = commentThreads(comments);
  const writer = canRecord(author.role);
  const commentForm = (replyTo?: number) => (
    <form action={addComment} className="space-y-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="id" value={result.id} />
      {replyTo && <input type="hidden" name={RESEARCH.replyTo} value={replyTo} />}
      <textarea name={RESEARCH.text} rows={replyTo ? 2 : 3} required className="w-full text-sm" placeholder={replyTo ? t.replyPlaceholder : t.commentPlaceholder} />
      <button className="btn text-xs">{replyTo ? t.reply : t.addComment}</button>
    </form>
  );
  const said = (c: EventRow) => (
    <>
      <p className="text-xs text-dim">{c.authorLabel ?? c.author ?? "—"} · {c.ts.toLocaleString(locale)}</p>
      <p className="mt-1 whitespace-pre-line break-words text-sm">{String(c.payload[RESEARCH.text] ?? "")}</p>
    </>
  );

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{result.name}</h1>
        <div className="flex gap-3 text-xs">
          {project && run && <Link href={`/research/o/${slug}/p/${project.id}/run/${run}`} className="text-frost hover:underline">{t.producedByRun.replace("{n}", String(run))}</Link>}
          {project && <Link href={`/research/o/${slug}/p/${project.id}`} className="text-dim hover:underline">← {project.name}</Link>}
        </div>
      </div>
      {links.length > 0 && <div className="mt-2"><OutsideLinks links={links} t={t} /></div>}
      <div className="mt-4"><Flash saved={saved} error={error} t={t} /></div>

      <div className="mt-2 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <dl className="card grid content-start gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2">
          {result.externalId && (
            <div><dt className="text-xs text-dim">{t.externalId}</dt><dd className="num break-words">{result.externalId}</dd></div>
          )}
          {shown.map(([k, s]) => (
            <div key={k}><dt className="text-xs text-dim">{label(s.label, locale, k)}</dt><dd className="whitespace-pre-line break-words">{fieldText(s, result.properties[k], locale)}</dd></div>
          ))}
          {extraRows.map(([k, s]) => (
            <div key={`x.${k}`}>
              <dt className="text-xs text-dim">{label(s?.label, locale, k)}</dt>
              <dd className="whitespace-pre-line break-words">{s ? fieldText(s, extra[k], locale) : typeof extra[k] === "object" ? JSON.stringify(extra[k]) : String(extra[k])}</dd>
            </div>
          ))}
        </dl>

        <form action={reviewResult} className="card space-y-3 p-4 text-sm">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="id" value={result.id} />
          <h2 className="font-medium">{t.review}</h2>
          {review?.enum && (
            <label className="block"><span className="text-xs text-dim">{label(review.label, locale, RESEARCH.review)}</span>
              <select name="review" defaultValue={String(result.properties[RESEARCH.review] ?? "")} className="mt-1 w-full" disabled={!writer}>
                {review.enum.map((v) => <option key={String(v)} value={String(v)}>{fieldText(review, v, locale)}</option>)}
              </select></label>
          )}
          {note && (
            <label className="block"><span className="text-xs text-dim">{label(note.label, locale, RESEARCH.note)}</span>
              <textarea name="note" rows={5} defaultValue={String(result.properties[RESEARCH.note] ?? "")} className="mt-1 w-full" disabled={!writer} /></label>
          )}
          {writer && <button className="btn">{t.saveReview}</button>}
        </form>
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-medium">{t.attachments}</h2>
        <Attachments db={db} slug={slug} docs={docs} t={t} locale={locale} />
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium">{t.comments} <span className="num text-dim">{comments.length || ""}</span></h2>
        {threads.length ? (
          <ul className="mt-3 space-y-3">
            {threads.map(({ comment, replies }) => (
              <li key={comment.rootId} className="card p-3">
                {said(comment)}
                {replies.length > 0 && (
                  <ul className="mt-3 space-y-3 border-l border-line-soft pl-4">
                    {replies.map((r) => <li key={r.rootId}>{said(r)}</li>)}
                  </ul>
                )}
                {writer && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-frost">{t.reply}</summary>
                    <div className="mt-2">{commentForm(comment.rootId)}</div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-dim">{t.noComments}</p>
        )}
        {writer && <div className="card mt-3 p-3">{commentForm()}</div>}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium">{t.objectHistory}</h2>
        <ActivityList entries={history} t={t} locale={locale} />
      </section>
    </div>
  );
}
