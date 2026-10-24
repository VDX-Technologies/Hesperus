import Link from "next/link";
import { notFound } from "next/navigation";
import { getT } from "@/lib/i18n";
import { listEvents } from "@/lib/engine/events";
import { canRecord } from "@/lib/engine/manual";
import { getObject } from "@/lib/engine/custom-objects";
import { RESEARCH } from "@/lib/research";
import { Flash } from "@/components/flash";
import { addLabNote } from "../../../actions";
import { researchContext } from "../../../context";

/** A project's lab notebook: the notes written on it, newest first, and a new one. */
export default async function Notes(props: PageProps<"/research/o/[slug]/p/[id]/notes">) {
  const { slug, id } = await props.params;
  const { saved, error } = await props.searchParams;
  const { db, author } = await researchContext(slug);
  const { t, locale } = await getT();
  const project = await getObject(db, id);
  if (!project || project.type !== RESEARCH.project) notFound();
  const notes = await listEvents(db, { types: [RESEARCH.labNote], objectId: project.id, recursive: false, limit: 500 });

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t.labNotes}</h1>
        <Link href={`/research/o/${slug}/p/${project.id}`} className="text-xs text-dim hover:underline">← {project.name}</Link>
      </div>
      <div className="mt-4"><Flash saved={saved} error={error} t={t} /></div>

      {canRecord(author.role) && (
        <form action={addLabNote} className="mt-4 space-y-2">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="id" value={project.id} />
          <textarea name={RESEARCH.text} rows={4} required className="w-full text-sm" placeholder={t.notePlaceholder} />
          <button className="btn text-xs">{t.writeNote}</button>
        </form>
      )}

      {notes.length ? (
        <ol className="mt-6 space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="card p-4">
              <p className="text-xs text-dim">{n.authorLabel ?? n.author ?? "—"} · {n.ts.toLocaleString(locale)}</p>
              <p className="mt-2 whitespace-pre-line break-words text-sm">{String(n.payload[RESEARCH.text] ?? "")}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-6 text-sm text-dim">{t.noNotes}</p>
      )}
    </div>
  );
}
