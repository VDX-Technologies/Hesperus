"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ManualEventError, canRecord, correctEvent, recordEvent, voidEvent } from "@/lib/engine/manual";
import { formSchema, saveEventType, specOf, type EventTypeInput } from "@/lib/engine/registers";
import { payloadFromForm } from "@/lib/engine/schema";
import type { EventFormState } from "@/components/terra/event-form";
import { registerContext, typeFrom } from "./context";

const text = (form: FormData) => Object.fromEntries([...form].filter(([, v]) => typeof v === "string")) as Record<string, string>;

/** Server error to a form state: validation text as is, the rest as a translated code. */
function fail(e: unknown): EventFormState {
  if (!(e instanceof ManualEventError)) throw e;
  if (e.status === 400) {
    const field = /property "([^"]+)"/.exec(e.message)?.[1];
    return field ? { fieldErrors: { [field]: e.message } } : { error: e.message };
  }
  return { error: `manualErr_${e.status}` };
}

/** Records an entry of any register, or with `supersedes` a corrected version of one. */
export async function recordEntry(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const slug = String(form.get("slug"));
  const ctx = await registerContext(slug);
  if (!canRecord(ctx.author.role)) return { error: "manualErr_403" };
  const t = await typeFrom(ctx, String(form.get("type")));
  if (!t) return { error: "manualErr_404" };
  const { payload, errors } = payloadFromForm(formSchema(t), text(form));
  if (Object.keys(errors).length) return { fieldErrors: errors };
  const { _ts, ...fields } = payload;
  const object = String(form.get("_object") ?? "");
  if (!object) return { error: "objectRequired" };
  const supersedes = Number(form.get("supersedes") || 0);
  try {
    const input = { ts: new Date(String(_ts)), payload: fields, objectIds: [object] };
    if (supersedes) await correctEvent(ctx.db, specOf(t, ctx.pkgs), ctx.author, supersedes, input);
    else await recordEvent(ctx.db, specOf(t, ctx.pkgs), ctx.author, input);
  } catch (e) {
    return fail(e);
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
    return fail(e);
  }
  revalidatePath(`/terra/o/${slug}`, "layout");
  redirect(`/terra/o/${slug}/registers/${encodeURIComponent(type)}`);
}
