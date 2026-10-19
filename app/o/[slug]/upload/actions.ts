"use server";
import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/auth";
import { crossTenantDb, tenantDb } from "@/lib/engine/db";
import { ConnectorError } from "@/lib/engine/connectors";
import { extract, type FileFormat } from "@/lib/engine/extract";
import { storeFromEnv } from "@/lib/engine/store";
import { ingestUpload, knownSubjects, saveUploadConfig, uploadConfig, uploadSources, type UploadResult } from "@/lib/engine/upload";
import { readMemory, recognize, type Recognition } from "@/lib/packages/records/recognize";
import { getPackage } from "@/lib/packages";

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
    return { result: { table: r.table, rows: r.rows, accepted: r.accepted, rejected: r.rejected, metrics: r.metrics, events: r.events } };
  } catch (e) {
    if (e instanceof ConnectorError) return { error: `uploadErr_${e.status === 404 ? 403 : e.status}` };
    throw e;
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
  const source = (await uploadSources(tdb)).find((s) => s.id === formData.get("source"));
  const { format, table } = await extract(file.name, file.type, new Uint8Array(await file.arrayBuffer()));
  if (!table) return { format, headers: [], rows: 0, sample: [], recognition: null };
  const recognition = recognize(table, {
    memory: readMemory(source?.config.memory),
    mapping: source ? uploadConfig(source).mapping : {},
    subjects: await knownSubjects(tdb),
  });
  return { format, headers: table.headers, rows: table.rows.length, sample: table.rows.slice(0, 5), recognition };
}
