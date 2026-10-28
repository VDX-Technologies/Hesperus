"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { tenantDb } from "@/lib/engine/db";
import { ManualEventError, archiveManualObject, canRecord, createManualObject, deleteManualObject, updateManualObject, type Role } from "@/lib/engine/manual";
import { payloadFromForm } from "@/lib/engine/schema";
import type { EventFormState } from "@/components/event-form";
import { agronomyPackage, CROP_FORM } from "@/lib/packages/agronomy";

const text = (form: FormData) => Object.fromEntries([...form].filter(([, v]) => typeof v === "string")) as Record<string, string>;

async function context(form: FormData) {
  const slug = String(form.get("slug"));
  const { user, org, role, modules } = await requireOrg(slug);
  if (!modules.some((m) => m.module === "agronomy")) throw new ManualEventError(404, "module not enabled");
  return { slug, db: tenantDb(org.id), author: { id: user.id, email: user.email, role: role as Role } };
}

function fail(e: unknown): EventFormState {
  if (!(e instanceof ManualEventError)) throw e;
  if (e.status === 400) {
    const field = /property "([^"]+)"/.exec(e.message)?.[1];
    return field ? { fieldErrors: { [field]: e.message } } : { error: e.message };
  }
  return { error: `manualErr_${e.status}` };
}

export async function saveCrop(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const { slug, db, author } = await context(form);
  if (!canRecord(author.role)) return { error: "manualErr_403" };
  const { payload, errors } = payloadFromForm(CROP_FORM, text(form));
  if (Object.keys(errors).length) return { fieldErrors: errors };
  const id = String(form.get("id") || "");
  try {
    if (id) await updateManualObject(db, agronomyPackage, author, id, payload);
    else
      await createManualObject(db, agronomyPackage, author, {
        type: "crop", name: String(form.get("name") ?? ""), properties: payload, placeId: String(form.get("place") || "") || null,
      });
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/terra/o/${slug}`, "layout");
  if (id) redirect(`/terra/o/${slug}/crops`);
  return { ok: Date.now() };
}

export async function cropAction(form: FormData): Promise<void> {
  const { slug, db, author } = await context(form);
  const id = String(form.get("id") ?? "");
  let error = "";
  try {
    if (form.get("op") === "delete") await deleteManualObject(db, agronomyPackage, author, id);
    else {
      const end = String(form.get("end") || "");
      await archiveManualObject(db, agronomyPackage, author, id, end ? new Date(`${end}T00:00:00Z`) : undefined);
    }
  } catch (e) {
    if (!(e instanceof ManualEventError)) throw e;
    error = `manualErr_${e.status}`;
  }
  revalidatePath(`/terra/o/${slug}`, "layout");
  redirect(`/terra/o/${slug}/crops${error ? `?error=${error}` : ""}`);
}
