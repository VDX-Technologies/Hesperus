// The forms of the custom objects and their types, read into the engine's calls. Every console
// that edits them (Terra's registers, Research) wraps these in its own server actions, which only
// add where the user lands afterwards: the checks and the writes are the engine's, the same for all.
import { ManualEventError, canRecord, type Author } from "./engine/manual";
import type { TenantDb } from "./engine/db";
import { payloadFromForm } from "./engine/schema";
import {
  createObject, deleteObject, getObject, getObjectType, saveObjectType, setLink, updateObject, type ObjectTypeInput,
} from "./engine/custom-objects";
import type { EventFormState } from "../components/event-form";

/** The text fields of a form (files left out). */
export const formText = (form: FormData) =>
  Object.fromEntries([...form].filter(([, v]) => typeof v === "string")) as Record<string, string>;

/** Server error to a form state: validation text as is, the rest as a translated code. */
export function formError(e: unknown): EventFormState {
  if (!(e instanceof ManualEventError)) throw e;
  if (e.status === 400) {
    const field = /property "([^"]+)"/.exec(e.message)?.[1];
    return field ? { fieldErrors: { [field]: e.message } } : { error: e.message };
  }
  return { error: `manualErr_${e.status}` };
}

type Saved<T> = { saved: T; state?: undefined } | { saved?: undefined; state: EventFormState };

/** Creates or replaces a custom object type from the editor's definition (owner only). */
export async function saveObjectTypeForm(db: TenantDb, author: Author, form: FormData): Promise<Saved<string>> {
  if (author.role !== "owner") return { state: { error: "manualErr_403" } };
  let input: ObjectTypeInput;
  try {
    input = JSON.parse(String(form.get("definition")));
  } catch {
    return { state: { error: "invalid definition" } };
  }
  try {
    return { saved: await saveObjectType(db, author, input) };
  } catch (e) {
    return { state: formError(e) };
  }
}

/** Creates an object of a custom type, or with `id` changes its name, properties and links. */
export async function saveObjectForm(db: TenantDb, author: Author, form: FormData): Promise<Saved<{ type: string; id: string }>> {
  if (!canRecord(author.role)) return { state: { error: "manualErr_403" } };
  const t = await getObjectType(db, String(form.get("type")));
  if (!t) return { state: { error: "manualErr_404" } };
  const { payload, errors } = payloadFromForm(t.properties, formText(form));
  if (Object.keys(errors).length) return { state: { fieldErrors: errors } };
  const links = Object.fromEntries(Object.keys(t.links).map((k) => [k, String(form.get(`_link.${k}`) ?? "")]));
  let id = String(form.get("id") ?? "");
  const name = String(form.get("_name") ?? "");
  try {
    if (!id) {
      const set = Object.fromEntries(Object.entries(links).filter(([, v]) => v));
      const externalId = String(form.get("_external") ?? "").trim() || null;
      id = await createObject(db, author, { type: t.type, name, externalId, properties: payload, links: set });
    } else {
      const o = await getObject(db, id);
      if (!o || o.type !== t.type) return { state: { error: "manualErr_404" } };
      // links first: a property following a parent's schema is checked against the new parent
      for (const [k, v] of Object.entries(links)) if ((o.links[k] ?? "") !== v) await setLink(db, author, id, k, v || null);
      const patch = Object.fromEntries(
        Object.keys(t.properties)
          .map((k) => [k, payload[k] ?? null] as const)
          .filter(([k, v]) => JSON.stringify(o.properties[k] ?? null) !== JSON.stringify(v)),
      );
      await updateObject(db, author, id, { name, properties: patch });
    }
  } catch (e) {
    return { state: formError(e) };
  }
  return { saved: { type: t.type, id } };
}

/** Deletes an object of a custom type nothing points at; the error code to show, or "" when done. */
export async function deleteObjectForm(db: TenantDb, author: Author, form: FormData): Promise<string> {
  try {
    await deleteObject(db, author, String(form.get("id")));
    return "";
  } catch (e) {
    if (!(e instanceof ManualEventError)) throw e;
    return e.status === 409 ? "objectLinkedErr" : `manualErr_${e.status}`;
  }
}
