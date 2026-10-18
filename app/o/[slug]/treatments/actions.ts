"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { tenantDb } from "@/lib/engine/db";
import { ManualEventError, canRecord, correctManualEvent, createManualEvent, createManualObject, type Role } from "@/lib/engine/manual";
import { payloadFromForm, type Schema } from "@/lib/engine/schema";
import type { EventFormState } from "@/components/event-form";
import { agronomyPackage, CROP_PROPERTIES } from "@/lib/packages/agronomy";
import { TREATMENT_FORM } from "@/lib/packages/agronomy/form";

const text = (form: FormData) => Object.fromEntries([...form].filter(([, v]) => typeof v === "string")) as Record<string, string>;

async function context(form: FormData) {
  const slug = String(form.get("slug"));
  const { user, org, role, modules } = await requireOrg(slug);
  if (!modules.some((m) => m.module === "agronomy")) throw new ManualEventError(404, "module not enabled");
  return { slug, db: tenantDb(org.id), author: { id: user.id, email: user.email, role: role as Role } };
}

function parse(schema: Schema, form: FormData) {
  const { payload, errors } = payloadFromForm(schema, text(form));
  return Object.keys(errors).length ? { errors } : { payload };
}

/** Server error to a form state: validation text as is, the rest as a translated code. */
function fail(e: unknown): EventFormState {
  if (!(e instanceof ManualEventError)) throw e;
  if (e.status === 400) {
    const field = /property "([^"]+)"/.exec(e.message)?.[1];
    return field ? { fieldErrors: { [field]: e.message } } : { error: e.message };
  }
  return { error: `manualErr_${e.status}` };
}

export async function createCrop(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const { slug, db, author } = await context(form);
  if (!canRecord(author.role)) return { error: "manualErr_403" };
  const p = parse(CROP_PROPERTIES, form);
  if (p.errors) return { fieldErrors: p.errors };
  try {
    await createManualObject(db, agronomyPackage, author, {
      type: "crop", name: String(form.get("name") ?? ""), properties: p.payload, placeId: String(form.get("place") || "") || null,
    });
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/o/${slug}`, "layout");
  return { ok: Date.now() };
}

/** Records a treatment, or with `supersedes` a corrected version of one. */
export async function recordTreatment(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  const { slug, db, author } = await context(form);
  if (!canRecord(author.role)) return { error: "manualErr_403" };
  const p = parse(TREATMENT_FORM, form);
  if (p.errors) return { fieldErrors: p.errors };
  const { date, ...payload } = p.payload;
  const crop = String(form.get("crop") ?? "");
  const isCrop = /^[0-9a-f-]{36}$/i.test(crop) && (await db.query(
    `select 1 from objects o join object_types t on t.id = o.type_id where o.tenant_id = $1 and o.id = $2 and t.module = 'agronomy' and t.key = 'crop'`,
    [db.tenantId, crop],
  )).rowCount;
  if (!isCrop) return { error: "cropRequired" };
  if (!date) return { fieldErrors: { date: "required" } };
  const supersedes = Number(form.get("supersedes") || 0);
  try {
    const input = { ts: new Date(String(date)), payload, objectIds: [crop] };
    if (supersedes) await correctManualEvent(db, agronomyPackage, author, supersedes, input);
    else await createManualEvent(db, agronomyPackage, author, { type: "treatment", ...input });
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/o/${slug}`, "layout");
  if (supersedes) redirect(`/o/${slug}/treatments`);
  return { ok: Date.now() };
}
