"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ManualEventError, canRecord, recordEvent } from "@/lib/engine/manual";
import { getObject, updateObject } from "@/lib/engine/custom-objects";
import { getEvent } from "@/lib/engine/events";
import { getEventType, specOf } from "@/lib/engine/registers";
import { batchPatch, RESEARCH, reviewPatch } from "@/lib/research";
import { deleteObjectForm, saveObjectForm, saveObjectTypeForm } from "@/lib/object-forms";
import type { EventFormState } from "@/components/event-form";
import { assignees, researchContext } from "./context";

/** Saves a result's review (its state and note); only what changed, in the audit trail. */
export async function reviewResult(form: FormData): Promise<void> {
  const slug = String(form.get("slug"));
  const id = String(form.get("id"));
  const { db, author } = await researchContext(slug);
  const base = `/research/o/${slug}/r/${id}`;
  let outcome = "?saved=1";
  try {
    if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot review");
    const o = await getObject(db, id);
    if (!o || o.type !== RESEARCH.result) throw new ManualEventError(404, "no such result");
    const patch = reviewPatch(o, String(form.get("review") ?? ""), String(form.get("note") ?? ""));
    if (patch) await updateObject(db, author, id, { properties: patch });
    else outcome = "?error=reviewUnchanged";
  } catch (e) {
    if (!(e instanceof ManualEventError)) throw e;
    outcome = `?error=manualErr_${e.status}`;
  }
  revalidatePath(`/research/o/${slug}`, "layout");
  redirect(base + outcome);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 500;

/**
 * Sets the review and / or the assignee of the selected results of a project, one audited change
 * per result; results already in that state are left alone.
 */
export async function reviewMany(form: FormData): Promise<void> {
  const slug = String(form.get("slug"));
  const project = String(form.get("project"));
  const { org, db, author } = await researchContext(slug);
  const home = `/research/o/${slug}/p/${project}`;
  const back = String(form.get("back") ?? "");
  const base = back === home || back.startsWith(`${home}?`) ? back : home;
  const ids = [...new Set(form.getAll("ids").map(String))].filter((id) => UUID.test(id)).slice(0, BATCH);
  const review = String(form.get("review") ?? "");
  const assignee = String(form.get("assignee") ?? "");
  let outcome = "saved=1";
  try {
    if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot review");
    if (!ids.length || (!review && !assignee)) throw new ManualEventError(400, "batchEmpty");
    if (assignee && assignee !== "-" && !(await assignees(org.id)).includes(assignee)) throw new ManualEventError(400, "not a member");
    let changed = 0;
    for (const id of ids) {
      const o = await getObject(db, id);
      if (!o || o.type !== RESEARCH.result || o.links[RESEARCH.link] !== project) continue;
      const patch = batchPatch(o, { review, assignee });
      if (!patch) continue;
      await updateObject(db, author, id, { properties: patch });
      changed++;
    }
    if (!changed) outcome = "error=batchUnchanged";
  } catch (e) {
    if (!(e instanceof ManualEventError)) throw e;
    outcome = e.message === "batchEmpty" ? "error=batchEmpty" : `error=manualErr_${e.status}`;
  }
  const url = new URL(base, "http://x");
  url.searchParams.delete("saved");
  url.searchParams.delete("error");
  revalidatePath(`/research/o/${slug}`, "layout");
  redirect(`${url.pathname}?${url.searchParams.size ? `${url.searchParams}&` : ""}${outcome}`);
}

/**
 * Records a text event (a lab note on a project, a comment on a result) and goes back to the page
 * it was written on; the engine checks the role, the subject's type and the text.
 */
async function recordText(form: FormData, type: string, page: (slug: string, id: string) => string, extra: (db: Awaited<ReturnType<typeof researchContext>>["db"], id: string) => Promise<Record<string, unknown>>) {
  const slug = String(form.get("slug"));
  const id = String(form.get("id"));
  const { db, author } = await researchContext(slug);
  let outcome = "?saved=1";
  try {
    if (!UUID.test(id)) throw new ManualEventError(404, "no such object");
    const t = await getEventType(db, [], type);
    if (!t) throw new ManualEventError(404, "no such type");
    const text = String(form.get(RESEARCH.text) ?? "").trim();
    if (!text) throw new ManualEventError(400, "textRequired");
    await recordEvent(db, specOf(t, []), author, { ts: new Date(), payload: { [RESEARCH.text]: text, ...(await extra(db, id)) }, objectIds: [id] });
  } catch (e) {
    if (!(e instanceof ManualEventError)) throw e;
    outcome = e.message === "textRequired" ? "?error=textRequired" : `?error=manualErr_${e.status}`;
  }
  revalidatePath(`/research/o/${slug}`, "layout");
  redirect(page(slug, id) + outcome);
}

/** Adds a note to a project's lab notebook. */
export async function addLabNote(form: FormData): Promise<void> {
  await recordText(form, RESEARCH.labNote, (slug, id) => `/research/o/${slug}/p/${id}/notes`, async () => ({}));
}

/**
 * Adds a comment to a result, or a reply: `reply_to` is the root id of the comment answered, so a
 * thread holds together when that comment is later corrected.
 */
export async function addComment(form: FormData): Promise<void> {
  await recordText(form, RESEARCH.comment, (slug, id) => `/research/o/${slug}/r/${id}`, async (db, id) => {
    const to = Number(form.get(RESEARCH.replyTo) || 0);
    if (!to) return {};
    const parent = await getEvent(db, to);
    if (!parent || parent.type !== RESEARCH.comment || parent.objectIds[0] !== id) throw new ManualEventError(404, "no such comment");
    return { [RESEARCH.replyTo]: parent.rootId };
  });
}

export type QuickReviewState = { error?: string; ok?: number } | null;

/**
 * A review from the queue: saved without leaving the page, which then shows the next result
 * still to review (the one just reviewed has left the queue).
 */
export async function quickReview(_prev: QuickReviewState, form: FormData): Promise<QuickReviewState> {
  const slug = String(form.get("slug"));
  const id = String(form.get("id"));
  const { db, author } = await researchContext(slug);
  try {
    if (!canRecord(author.role)) throw new ManualEventError(403, "viewers cannot review");
    const o = await getObject(db, id);
    if (!o || o.type !== RESEARCH.result) throw new ManualEventError(404, "no such result");
    const patch = reviewPatch(o, String(form.get("review") ?? ""), String(form.get("note") ?? ""));
    if (!patch) return { error: "reviewUnchanged" };
    await updateObject(db, author, id, { properties: patch });
  } catch (e) {
    if (!(e instanceof ManualEventError)) throw e;
    return { error: `manualErr_${e.status}` };
  }
  revalidatePath(`/research/o/${slug}`, "layout");
  return { ok: Date.now() };
}

/** Creates or replaces a custom object type from the schema editor (owner only). */
export async function saveObjectTypeAction(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const slug = String(form.get("slug"));
  const { db, author } = await researchContext(slug);
  const r = await saveObjectTypeForm(db, author, form);
  if (r.saved === undefined) return r.state;
  revalidatePath(`/research/o/${slug}`, "layout");
  redirect(`/research/o/${slug}/objects/${encodeURIComponent(r.saved)}`);
}

/** Creates an object of a custom type, or with `id` changes its name, properties and links. */
export async function saveObjectAction(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const slug = String(form.get("slug"));
  const { db, author } = await researchContext(slug);
  const r = await saveObjectForm(db, author, form);
  if (r.saved === undefined) return r.state;
  revalidatePath(`/research/o/${slug}`, "layout");
  redirect(`/research/o/${slug}/objects/${encodeURIComponent(r.saved.type)}?saved=${r.saved.id}`);
}

/** Deletes an object of a custom type nothing points at. */
export async function deleteObjectAction(form: FormData): Promise<void> {
  const slug = String(form.get("slug"));
  const { db, author } = await researchContext(slug);
  const base = `/research/o/${slug}/objects/${encodeURIComponent(String(form.get("type")))}`;
  const error = await deleteObjectForm(db, author, form);
  revalidatePath(`/research/o/${slug}`, "layout");
  redirect(error ? `${base}?error=${error}` : base);
}
