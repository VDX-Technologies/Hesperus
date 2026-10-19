// An uploaded file as it was loaded, from the archive, for anyone who can read the tenant.
import { requireOrg } from "@/lib/auth";
import { tenantDb } from "@/lib/engine/db";
import { storeFromEnv } from "@/lib/engine/store";

export async function GET(_req: Request, rctx: RouteContext<"/o/[slug]/upload/[id]">) {
  const { slug, id } = await rctx.params;
  const { org } = await requireOrg(slug);
  const { rows } = await tenantDb(org.id).query<{ storage_key: string; filename: string | null; content_type: string | null }>(
    `select storage_key, filename, content_type from documents where tenant_id = $1 and id = $2`,
    [org.id, id],
  );
  const bytes = rows[0] && (await storeFromEnv().get(rows[0].storage_key));
  if (!bytes) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": rows[0].content_type || "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].filename ?? "file")}`,
    },
  });
}
