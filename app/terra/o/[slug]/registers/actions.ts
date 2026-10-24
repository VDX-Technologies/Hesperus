"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ManualEventError, canRecord, correctEvent, recordEvent, voidEvent } from "@/lib/engine/manual";
import { formSchema, saveEventType, specOf, type EventTypeInput } from "@/lib/engine/registers";
import { payloadFromForm } from "@/lib/engine/schema";
import { deleteObjectForm, formError, formText, saveObjectForm, saveObjectTypeForm } from "@/lib/object-forms";
import type { EventFormState } from "@/components/event-form";
import { registerContext, typeFrom } from "./context";

/** Records an entry of any register, or with `supersedes` a corrected version of one. */
export async function recordEntry(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const slug = String(form.get("slug"));
  const ctx = await registerContext(slug);
  if (!canRecord(ctx.author.role)) return { error: "manualErr_403" };
  const t = await typeFrom(ctx, String(form.get("type")));
  if (!t) return { error: "manualErr_404" };
  const { payload, errors } = payloadFromForm(formSchema(t), formText(form));
  if (Object.keys(errors).length) return { fieldErrors: errors };
  const { _ts, ...fields } = payload;
  const object = String(form.get("_object") ?? "");
  if (!object) return { error: "objectRequired" };
  const supersedes = Number(form.get("supersedes") || 0);
  try {
    // the other objects of the `also` types, checked by the engine
    const also = form.getAll("_also").map(String).filter(Boolean);
    const input = { ts: new Date(String(_ts)), payload: fields, objectIds: [object, ...new Set(also)] };
    if (supersedes) await correctEvent(ctx.db, specOf(t, ctx.pkgs), ctx.author, supersedes, input);
    else await recordEvent(ctx.db, specOf(t, ctx.pkgs), ctx.author, input);
  } catch (e) {
    return formError(e);
  }
  revalidatePath(`/terra/o/${slug}`, "layout");
  if (supersedes) redirect(`/terra/o/${slug}/registers/${encodeURIComponent(t.type)}`);
  return { ok: Date.now() };
}

/** Voids an entry with the reason given; it leaves the lists and stays in the history. */
export async function voidEntry(form: FormData): Promise<void> {
  const slug = String(form.get("slug"));
  const ctx = await registerContext(slug);
  const base = `/terra/o/${slug}/registers/${encodeURIComponent(String(form.get("type")))}`;
  let error = "";
  try {
    await voidEvent(ctx.db, ctx.author, Number(form.get("id")), String(form.get("reason") ?? ""));
  } catch (e) {
    if (!(e instanceof ManualEventError)) throw e;
    error = e.status === 400 ? "voidReasonRequired" : `manualErr_${e.status}`;
  }
  revalidatePath(`/terra/o/${slug}`, "layout");
  redirect(error ? `${base}?error=${error}` : `${base}?voided=1`);
}

/** Creates or replaces a custom event type from the editor (owner only). */
export async function saveType(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const slug = String(form.get("slug"));
  const ctx = await registerContext(slug);
  if (ctx.author.role !== "owner") return { error: "manualErr_403" };
  let input: EventTypeInput;
  try {
    input = JSON.parse(String(form.get("definition")));
  } catch {
    return { error: "invalid definition" };
  }
  let type: string;
  try {
    type = await saveEventType(ctx.db, ctx.author, input);
  } catch (e) {
    return formError(e);
  }
  revalidatePath(`/terra/o/${slug}`, "layout");
  redirect(`/terra/o/${slug}/registers/${encodeURIComponent(type)}`);
}

/** Creates or replaces a custom object type from the editor (owner only). */
export async function saveObjectTypeAction(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const slug = String(form.get("slug"));
  const ctx = await registerContext(slug);
  const r = await saveObjectTypeForm(ctx.db, ctx.author, form);
  if (r.saved === undefined) return r.state;
  revalidatePath(`/terra/o/${slug}`, "layout");
  redirect(`/terra/o/${slug}/registers/objects/${encodeURIComponent(r.saved)}`);
}

/** Creates an object of a custom type, or with `id` changes its name, properties and links. */
export async function saveObjectAction(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const slug = String(form.get("slug"));
  const ctx = await registerContext(slug);
  const r = await saveObjectForm(ctx.db, ctx.author, form);
  if (r.saved === undefined) return r.state;
  revalidatePath(`/terra/o/${slug}`, "layout");
  redirect(`/terra/o/${slug}/registers/objects/${encodeURIComponent(r.saved.type)}?saved=${r.saved.id}`);
}

/** Deletes an object of a custom type nothing points at. */
export async function deleteObjectAction(form: FormData): Promise<void> {
  const slug = String(form.get("slug"));
  const ctx = await registerContext(slug);
  const base = `/terra/o/${slug}/registers/objects/${encodeURIComponent(String(form.get("type")))}`;
  const error = await deleteObjectForm(ctx.db, ctx.author, form);
  revalidatePath(`/terra/o/${slug}`, "layout");
  redirect(error ? `${base}?error=${error}` : base);
}
