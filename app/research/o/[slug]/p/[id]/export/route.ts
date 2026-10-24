// A project's results as CSV or JSON, with the same filters and order as its page. Every
// matching result, read in pages and streamed.
import { getObject, getObjectType, searchObjects } from "@/lib/engine/custom-objects";
import { projectFields, RESEARCH, resultFilters, resultsCsv } from "@/lib/research";
import { researchContext } from "../../../context";

const CHUNK = 2000;

export async function GET(req: Request, rctx: RouteContext<"/research/o/[slug]/p/[id]/export">) {
  const { slug, id } = await rctx.params;
  const { db, author } = await researchContext(slug);
  const [project, resultType] = await Promise.all([getObject(db, id), getObjectType(db, RESEARCH.result)]);
  if (!project || project.type !== RESEARCH.project || !resultType) return new Response("not found", { status: 404 });
  const sp = new URL(req.url).searchParams;
  const format = sp.get("format") ?? "csv";
  if (format !== "csv" && format !== "json") return new Response("unknown format", { status: 400 });

  const own = projectFields(project);
  const filters = resultFilters(Object.fromEntries(sp), project.id, { result: resultType.properties, own, me: author.email });
  async function* results() {
    for (let offset = 0; ; offset += CHUNK) {
      const { objects } = await searchObjects(db, RESEARCH.result, { ...filters, limit: CHUNK, offset });
      yield* objects;
      if (objects.length < CHUNK) return;
    }
  }

  const enc = new TextEncoder();
  const csv = resultsCsv(resultType.properties, own);
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      try {
        if (format === "csv") {
          c.enqueue(enc.encode(csv.header));
          for await (const o of results()) c.enqueue(enc.encode(csv.line(o)));
        } else {
          let first = true;
          c.enqueue(enc.encode("["));
          for await (const o of results()) {
            const { id, externalId, name, properties, createdAt } = o;
            c.enqueue(enc.encode(`${first ? "" : ","}\n${JSON.stringify({ id, externalId, name, properties, createdAt })}`));
            first = false;
          }
          c.enqueue(enc.encode("\n]\n"));
        }
        c.close();
      } catch (e) {
        c.error(e);
      }
    },
  });
  const name = `${project.name.replace(/\W+/g, "-").replace(/^-|-$/g, "") || "project"}-${new Date().toISOString().slice(0, 10)}`;
  return new Response(body, {
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.${format}"`,
      "cache-control": "private, no-store",
    },
  });
}
