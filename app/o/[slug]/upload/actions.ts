"use server";
import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/auth";
import { crossTenantDb, tenantDb } from "@/lib/engine/db";
import { ConnectorError } from "@/lib/engine/connectors";
import { storeFromEnv } from "@/lib/engine/store";
import { ingestUpload, saveUploadConfig, uploadSources, type UploadResult } from "@/lib/engine/upload";
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
    return { result: { rows: r.rows, accepted: r.accepted, rejected: r.rejected, metrics: r.metrics, events: r.events } };
  } catch (e) {
    if (e instanceof ConnectorError) return { error: `uploadErr_${e.status === 404 ? 403 : e.status}` };
    throw e;
  }
}
