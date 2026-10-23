/** GET /api/firmware/<version> - the firmware binary, for the nodes (same auth as the manifest). */
import { getRelease } from "@/lib/engine/firmware";
import { storeFromEnv } from "@/lib/engine/store";
import { nodeSource } from "../node-auth";

export async function GET(request: Request, rctx: RouteContext<"/api/firmware/[version]">) {
  const node = await nodeSource(request);
  if ("error" in node) return node.error;
  const release = await getRelease(node.db, (await rctx.params).version);
  const bytes = release && (await storeFromEnv().get(release.storage_key));
  if (!release || !bytes) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
      "x-md5": release.md5,
    },
  });
}
