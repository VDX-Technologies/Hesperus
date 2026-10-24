// A result's attachment: raster images inline (the console's preview), a PDF inline when asked
// for with `?view=1` (its frame on the result page), anything else downloaded.
import { inlineImage, isPdf } from "@/lib/research";
import { researchContext } from "../../context";
import { readDocument } from "../../documents";

export async function GET(req: Request, rctx: RouteContext<"/research/o/[slug]/doc/[id]">) {
  const { slug, id } = await rctx.params;
  const { db } = await researchContext(slug);
  const d = await readDocument(db, id);
  if (!d) return new Response("not found", { status: 404 });
  const pdf = isPdf(d.contentType) && new URL(req.url).searchParams.get("view") === "1";
  const inline = inlineImage(d.contentType) || pdf;
  return new Response(d.bytes, {
    headers: {
      "content-type": pdf ? "application/pdf" : inline ? d.contentType! : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(d.filename ?? "file")}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
    },
  });
}
