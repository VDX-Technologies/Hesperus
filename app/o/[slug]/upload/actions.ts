"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { crossTenantDb, tenantDb } from "@/lib/engine/db";
import { ConnectorError } from "@/lib/engine/connectors";
import { extract, ExtractLimitError, type FileFormat } from "@/lib/engine/extract";
import { getSettings, num } from "@/lib/engine/settings";
import { storeFromEnv } from "@/lib/engine/store";
import { deleteUpload, ingestUpload, knownSubjects, reprocessUpload, saveUploadConfig, uploadConfig, uploadSources, type UploadResult } from "@/lib/engine/upload";
import { readMemory, recognize, type Recognition } from "@/lib/packages/records/recognize";
import { getPackage } from "@/lib/packages";
import { moveLegacyEntries } from "@/lib/packages/agronomy/import";

export type UploadState = { error?: string; result?: Omit<UploadResult, "documentId"> } | null;

/** Saves the column mapping chosen in the form, then loads the file through the source (owner only). */
export async function uploadFile(_prev: UploadState, formData: FormData): Promise<UploadState> {
  const slug = String(formData.get("slug"));
  const { user, org, role } = await requireOrg(slug);
  if (role !== "owner") return { error: "uploadOnlyOwner" };
  const tdb = tenantDb(org.id);
  const source = (await uploadSources(tdb)).find((s) => s.id === formData.get("source"));
  const pkg = source && getPackage(source.module);
  if (!source || !pkg) return { error: "uploadErr_403" };
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) return { error: "uploadErr_400" };
  const settings = await getSettings(crossTenantDb("settings"));
  const maxBytes = num(settings, "upload.max_bytes", 5 * 1024 ** 2);
  if (file.size > maxBytes) return { error: "uploadErr_413" };

  const mapping: Record<string, string> = {};
  for (const [k, v] of formData) if (k.startsWith("map_") && typeof v === "string" && v) mapping[k.slice(4)] = v;
  try {
    await saveUploadConfig(tdb, source.id, { mapping }, user);
    const r = await ingestUpload(
      crossTenantDb("ingest"),
      storeFromEnv(),
      { ...source, config: { ...source.config, mapping } },
      { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
      pkg,
      user,
    );
    revalidatePath(`/o/${slug}`, "layout");
    return { result: { table: r.table, register: r.register, rows: r.rows, accepted: r.accepted, rejected: r.rejected, metrics: r.metrics, events: r.events } };
  } catch (e) {
    if (e instanceof ConnectorError) return { error: `uploadErr_${e.status === 404 ? 403 : e.status}` };
    console.error("upload failed", e);
    return { error: "uploadErr_500" };
  }
}

export type Preview =
  | { format: FileFormat; headers: string[]; rows: number; sample: string[][]; recognition: Recognition | null }
  | { error: string };

/**
 * Reads a chosen file on the server and says what each column of its table is: the field, how sure,
 * and whether the register has seen files like it. The first rows come back for the preview.
 */
export async function previewFile(formData: FormData): Promise<Preview> {
  const { org, role } = await requireOrg(String(formData.get("slug")));
  if (role !== "owner") return { error: "uploadOnlyOwner" };
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) return { error: "uploadErr_400" };
  const tdb = tenantDb(org.id);
  const settings = await getSettings(crossTenantDb("settings"));
  const maxBytes = num(settings, "upload.max_bytes", 5 * 1024 ** 2);
  const maxRows = num(settings, "upload.max_rows", 5000);
  if (file.size > maxBytes) return { error: "uploadErr_413" };
  const source = (await uploadSources(tdb)).find((s) => s.id === formData.get("source"));
  let found: Awaited<ReturnType<typeof extract>>;
  try {
    found = await extract(file.name, file.type, new Uint8Array(await file.arrayBuffer()), { maxBytes, maxRows });
  } catch (e) {
    if (e instanceof ExtractLimitError) return { error: "uploadErr_413" };
    throw e;
  }
  const { format, table } = found;
  if (!table) return { format, headers: [], rows: 0, sample: [], recognition: null };
  const recognition = recognize(table, {
    memory: readMemory(source?.config.memory),
    mapping: source ? uploadConfig(source).mapping : {},
    subjects: await knownSubjects(tdb),
  });
  return { format, headers: table.headers, rows: table.rows.length, sample: table.rows.slice(0, 5), recognition };
}

/** Owner-only actions on the uploaded files; each comes back to the page with a message. */
async function owner(formData: FormData) {
  const slug = String(formData.get("slug"));
  const ctx = await requireOrg(slug);
  const back = `/o/${slug}/upload`;
  if (ctx.role !== "owner") redirect(`${back}?error=uploadOnlyOwner`);
  return { ...ctx, slug, back };
}

export async function deleteDocument(formData: FormData) {
  const { user, org, slug, back } = await owner(formData);
  const r = await deleteUpload(tenantDb(org.id), String(formData.get("id")), user);
  revalidatePath(`/o/${slug}`, "layout");
  redirect(r ? `${back}?done=deleted&n=${r.events}` : `${back}?error=uploadErr_403`);
}

export async function reprocessDocument(formData: FormData) {
  const { user, org, slug, back } = await owner(formData);
  let to: string;
  try {
    const r = await reprocessUpload(crossTenantDb("ingest"), storeFromEnv(), org.id, String(formData.get("id")), getPackage, user);
    to = `${back}?done=reprocessed&n=${r.events}`;
  } catch (e) {
    if (!(e instanceof ConnectorError)) console.error("reprocess failed", e);
    to = `${back}?error=uploadErr_${e instanceof ConnectorError ? (e.status === 404 ? 403 : e.status) : 500}`;
  }
  revalidatePath(`/o/${slug}`, "layout");
  redirect(to);
}

export async function moveLegacy(formData: FormData) {
  const { user, org, slug, back } = await owner(formData);
  const r = await moveLegacyEntries(crossTenantDb("ingest"), org.id, user);
  revalidatePath(`/o/${slug}`, "layout");
  redirect(`${back}?done=moved&n=${r.moved}`);
}
