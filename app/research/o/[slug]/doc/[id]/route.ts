// A result's attachment: raster images inline (the console's preview), anything else downloaded.
import { storeFromEnv } from "@/lib/engine/store";
import { inlineImage } from "@/lib/research";
import { researchContext } from "../../context";

export async function GET(_req: Request, rctx: RouteContext<"/research/o/[slug]/doc/[id]">) {
  const { slug, id } = await rctx.params;
  const { db } = await researchContext(slug);
  const { rows } = await db.query<{ storage_key: string; filename: string | null; content_type: string | null }>(
    `select storage_key, filename, content_type from documents where tenant_id = $1 and id = $2`,
    [db.tenantId, id],
  );
  const bytes = rows[0] && (await storeFromEnv().get(rows[0].storage_key));
  if (!bytes) return new Response("not found", { status: 404 });
  const image = inlineImage(rows[0].content_type);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": image ? rows[0].content_type! : "application/octet-stream",
      "content-disposition": `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(rows[0].filename ?? "file")}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
    },
  });
}
