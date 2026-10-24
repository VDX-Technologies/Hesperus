"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ManualEventError, canRecord } from "@/lib/engine/manual";
import { getObject, updateObject } from "@/lib/engine/custom-objects";
import { RESEARCH, reviewPatch } from "@/lib/research";
import { deleteObjectForm, saveObjectForm, saveObjectTypeForm } from "@/lib/object-forms";
import type { EventFormState } from "@/components/event-form";
import { researchContext } from "./context";

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
