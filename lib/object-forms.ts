import { ManualEventError, canRecord, type Author } from "./engine/manual";
import type { TenantDb } from "./engine/db";
import { payloadFromForm } from "./engine/schema";
import {
  createObject, deleteObject, getObject, getObjectType, saveObjectType, setLink, updateObject, type ObjectTypeInput,
} from "./engine/custom-objects";
import type { EventFormState } from "../components/event-form";

export const formText = (form: FormData) =>
  Object.fromEntries([...form].filter(([, v]) => typeof v === "string")) as Record<string, string>;

export function formError(e: unknown): EventFormState {
  if (!(e instanceof ManualEventError)) throw e;
  if (e.status === 400) {
    const field = /property "([^"]+)"/.exec(e.message)?.[1];
    return field ? { fieldErrors: { [field]: e.message } } : { error: e.message };
  }
  return { error: `manualErr_${e.status}` };
}

type Saved<T> = { saved: T; state?: undefined } | { saved?: undefined; state: EventFormState };

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

export async function deleteObjectForm(db: TenantDb, author: Author, form: FormData): Promise<string> {
  try {
    await deleteObject(db, author, String(form.get("id")));
    return "";
  } catch (e) {
    if (!(e instanceof ManualEventError)) throw e;
    return e.status === 409 ? "objectLinkedErr" : `manualErr_${e.status}`;
  }
}
