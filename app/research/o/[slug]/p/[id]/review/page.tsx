import Link from "next/link";
import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { canRecord } from "@/lib/engine/manual";
import { fieldText, label } from "@/lib/engine/registers";
import { getObject, getObjectType, objectDocuments, searchObjects } from "@/lib/engine/custom-objects";
import { expandLinks, filterQuery, projectFields, RESEARCH, resultFilters, REVIEW_KEYS } from "@/lib/research";
import { ReviewKeys } from "@/components/research/review-keys";
import { quickReview } from "../../../actions";
import { researchContext } from "../../../context";
import { Attachments, OutsideLinks } from "../../../attachments";

/**
 * The review queue: the project's results still to review, one at a time, highest score first
 * (or in the order and with the filters of the results table), reviewed from the keyboard.
 */
export default async function ReviewQueue(props: PageProps<"/research/o/[slug]/p/[id]/review">) {
  const { slug, id } = await props.params;
  const sp = await props.searchParams;
  const { db, author } = await researchContext(slug);
  const { t, locale } = await getT();
  const [project, resultType] = await Promise.all([getObject(db, id), getObjectType(db, RESEARCH.result)]);
  if (!project || project.type !== RESEARCH.project || !resultType) notFound();

  const own = projectFields(project);
  const filters = resultFilters({ ...sp, review: RESEARCH.pending }, project.id, { result: resultType.properties, own, me: author.email });
  const pos = Math.max(0, Math.floor(Number(typeof sp.pos === "string" ? sp.pos : 0) || 0));
  const { objects, total } = await searchObjects(db, RESEARCH.result, { ...filters, limit: 1, offset: pos });
  const result = objects[0];
  const back = `/research/o/${slug}/p/${project.id}`;
  const keep = filterQuery(sp);
  keep.delete("review");
  const at = (p: number) => {
    const q = new URLSearchParams(keep);
    if (p > 0) q.set("pos", String(p));
    return q.size ? `${back}/review?${q}` : `${back}/review`;
  };

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{t.reviewQueue}</h1>
      <Link href={keep.size ? `${back}?${keep}` : back} className="text-xs text-dim hover:underline">← {project.name}</Link>
    </div>
  );
  if (!result)
    return (
      <div>
        {header}
        <p className="card mt-6 p-6 text-sm text-dim">{pos > 0 && total > 0 ? <Link href={at(0)} className="text-frost hover:underline">{t.firstPage}</Link> : t.queueEmpty}</p>
      </div>
    );

  const docs = await objectDocuments(db, result.id);
  const review = resultType.properties[RESEARCH.review];
  const note = resultType.properties[RESEARCH.note];
  const keyOf = Object.fromEntries(Object.entries(REVIEW_KEYS).map(([k, v]) => [v, k]));
  const choices = (review?.enum ?? []).map(String).filter((v) => v !== RESEARCH.pending)
    .map((v) => ({ value: v, label: fieldText(review, v, locale), key: keyOf[v] }));
  const hidden = new Set<string>([RESEARCH.review, RESEARCH.note]);
  const shown = Object.entries(resultType.properties).filter(([k, s]) => s.type !== "object" && !hidden.has(k) && result.properties[k] !== undefined);
  const extra = (result.properties[RESEARCH.extra] ?? {}) as Record<string, unknown>;
  const extraRows = Object.entries(own).filter(([k]) => extra[k] !== undefined);
  const links = expandLinks(project.properties[RESEARCH.links], result);

  return (
    <div>
      {header}
      <p className="mt-1 text-xs text-dim"><span className="num">{pos + 1}</span> {t.ofTotal} <span className="num">{total}</span></p>

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="text-lg font-medium"><Link href={`/research/o/${slug}/r/${result.id}`} className="hover:underline">{result.name}</Link></h2>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {result.externalId && <div><dt className="text-xs text-dim">{t.externalId}</dt><dd className="num break-words">{result.externalId}</dd></div>}
              {shown.map(([k, s]) => (
                <div key={k}><dt className="text-xs text-dim">{label(s.label, locale, k)}</dt><dd className="whitespace-pre-line break-words">{fieldText(s, result.properties[k], locale)}</dd></div>
              ))}
              {extraRows.map(([k, s]) => (
                <div key={`x.${k}`}><dt className="text-xs text-dim">{label(s.label, locale, k)}</dt><dd className="whitespace-pre-line break-words">{fieldText(s, extra[k], locale)}</dd></div>
              ))}
            </dl>
            {links.length > 0 && <div className="mt-3"><OutsideLinks links={links} t={t} /></div>}
          </div>
          <div><Attachments db={db} slug={slug} docs={docs} t={t} locale={locale} /></div>
        </div>

        {canRecord(author.role) ? (
          <ReviewKeys
            key={result.id}
            action={quickReview}
            slug={slug}
            id={result.id}
            choices={choices}
            note={note ? String(result.properties[RESEARCH.note] ?? "") : null}
            noteLabel={label(note?.label, locale, RESEARCH.note)}
            prev={pos > 0 ? at(pos - 1) : null}
            next={pos + 1 < total ? at(pos + 1) : null}
            labels={{
              hint: t.queueHint, previous: t.previous, skip: t.skip, saving: t.saving,
              errors: { reviewUnchanged: t.reviewUnchanged, manualErr_403: t.manualErr_403, manualErr_404: t.manualErr_404 },
            }}
          />
        ) : (
          <div className="card space-y-2 p-4 text-sm text-dim">
            <div className="flex justify-between text-xs">
              {pos > 0 ? <Link href={at(pos - 1)} className="text-frost hover:underline">← {t.previous}</Link> : <span />}
              {pos + 1 < total && <Link href={at(pos + 1)} className="text-frost hover:underline">{t.skip} →</Link>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
