import { currentRelease } from "@/lib/engine/firmware";
import { nodeSource } from "../node-auth";

export async function GET(request: Request) {
  const node = await nodeSource(request);
  if ("error" in node) return node.error;
  const release = await currentRelease(node.db);
  if (!release) return Response.json({ error: "no current firmware" }, { status: 404 });
  const url = new URL(`/api/firmware/${release.version}`, request.url).toString();
  return Response.json({ version: release.version, url, md5: release.md5, sha256: release.sha256, signature: release.signature }, { headers: { "cache-control": "no-store" } });
}
