"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ManualEventError, canRecord, correctEvent, recordEvent, voidEvent } from "@/lib/engine/manual";
import { formSchema, saveEventType, specOf, type EventTypeInput } from "@/lib/engine/registers";
import { payloadFromForm } from "@/lib/engine/schema";
import {
  createObject, deleteObject, getObject, getObjectType, saveObjectType, setLink, updateObject, type ObjectTypeInput,
} from "@/lib/engine/custom-objects";
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
    // the other objects of the `also` types, checked by the engine
    const also = form.getAll("_also").map(String).filter(Boolean);
    const input = { ts: new Date(String(_ts)), payload: fields, objectIds: [object, ...new Set(also)] };
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

/** Creates or replaces a custom object type from the editor (owner only). */
export async function saveObjectTypeAction(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const slug = String(form.get("slug"));
  const ctx = await registerContext(slug);
  if (ctx.author.role !== "owner") return { error: "manualErr_403" };
  let input: ObjectTypeInput;
  try {
    input = JSON.parse(String(form.get("definition")));
  } catch {
    return { error: "invalid definition" };
  }
  let type: string;
  try {
    type = await saveObjectType(ctx.db, ctx.author, input);
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/terra/o/${slug}`, "layout");
  redirect(`/terra/o/${slug}/registers/objects/${encodeURIComponent(type)}`);
}

/** Creates an object of a custom type, or with `id` changes its name, properties and links. */
export async function saveObjectAction(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const slug = String(form.get("slug"));
  const ctx = await registerContext(slug);
  if (!canRecord(ctx.author.role)) return { error: "manualErr_403" };
  const t = await getObjectType(ctx.db, String(form.get("type")));
  if (!t) return { error: "manualErr_404" };
  const { payload, errors } = payloadFromForm(t.properties, text(form));
  if (Object.keys(errors).length) return { fieldErrors: errors };
  const links = Object.fromEntries(Object.keys(t.links).map((k) => [k, String(form.get(`_link.${k}`) ?? "")]));
  let id = String(form.get("id") ?? "");
  const name = String(form.get("_name") ?? "");
  try {
    if (!id) {
      const set = Object.fromEntries(Object.entries(links).filter(([, v]) => v));
      const externalId = String(form.get("_external") ?? "").trim() || null;
      id = await createObject(ctx.db, ctx.author, { type: t.type, name, externalId, properties: payload, links: set });
    } else {
      const o = await getObject(ctx.db, id);
      if (!o || o.type !== t.type) return { error: "manualErr_404" };
      // links first: a property following a parent's schema is checked against the new parent
      for (const [k, v] of Object.entries(links)) if ((o.links[k] ?? "") !== v) await setLink(ctx.db, ctx.author, id, k, v || null);
      const patch = Object.fromEntries(
        Object.keys(t.properties)
          .map((k) => [k, payload[k] ?? null] as const)
          .filter(([k, v]) => JSON.stringify(o.properties[k] ?? null) !== JSON.stringify(v)),
      );
      await updateObject(ctx.db, ctx.author, id, { name, properties: patch });
    }
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/terra/o/${slug}`, "layout");
  redirect(`/terra/o/${slug}/registers/objects/${encodeURIComponent(t.type)}?saved=${id}`);
}

/** Deletes an object of a custom type nothing points at. */
export async function deleteObjectAction(form: FormData): Promise<void> {
  const slug = String(form.get("slug"));
  const ctx = await registerContext(slug);
  const base = `/terra/o/${slug}/registers/objects/${encodeURIComponent(String(form.get("type")))}`;
  let error = "";
  try {
    await deleteObject(ctx.db, ctx.author, String(form.get("id")));
  } catch (e) {
    if (!(e instanceof ManualEventError)) throw e;
    error = e.status === 409 ? "objectLinkedErr" : `manualErr_${e.status}`;
  }
  revalidatePath(`/terra/o/${slug}`, "layout");
  redirect(error ? `${base}?error=${error}` : base);
}
