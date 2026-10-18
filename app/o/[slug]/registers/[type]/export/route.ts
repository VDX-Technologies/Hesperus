// A register as PDF or CSV, or one of the exports its package adds, with the same filters as
// the page. Every filtered row, read in chunks with the keyset; the CSV is streamed.
import { getT } from "@/lib/i18n";
import { allEvents } from "@/lib/engine/events";
import { tablePdf } from "@/lib/engine/pdf";
import { csvHeader, csvLine, filtersFrom, label, registerCell, registerColumns, registerQuery } from "@/lib/engine/registers";
import { getSettings, num } from "@/lib/engine/settings";
import { exportsOf } from "@/lib/packages/exports";
import { objectNames, registerContext, typeFrom } from "../../context";

export async function GET(req: Request, rctx: RouteContext<"/o/[slug]/registers/[type]/export">) {
  const { slug, type: param } = await rctx.params;
  const ctx = await registerContext(slug);
  const type = await typeFrom(ctx, param);
  if (!type) return new Response("not found", { status: 404 });
  const { t, locale } = await getT();
  const sp = new URL(req.url).searchParams;
  const filters = filtersFrom(type, Object.fromEntries(sp));
  const format = sp.get("format") ?? "pdf";
  const name = `${type.type.replace(/\W+/g, "-")}-${slug}-${new Date().toISOString().slice(0, 10)}`;

  const extra = exportsOf(type.type).find((x) => x.id === format);
  if (extra) return extra.run({ db: ctx.db, type, filters, organization: ctx.org.name, name, locale });

  const chunk = num(await getSettings(ctx.db.shared), "registers.export_chunk", 500);
  const names = await objectNames(ctx, type);
  const events = () => allEvents(ctx.db, { ...registerQuery(type, filters), asc: true }, chunk);

  if (format === "csv") {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode(csvHeader(type)));
        for await (const e of events()) c.enqueue(enc.encode(csvLine(type, e, names)));
        c.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"` } });
  }
  if (format !== "pdf") return new Response("unknown format", { status: 400 });

  const columns = registerColumns(type, locale, { date: t.date, object: t.object, author: t.recordedBy });
  const fixed: Record<string, number> = { _date: 0.08, _object: 0.14, _author: 0.12 };
  const rest = (1 - Object.values(fixed).reduce((a, b) => a + b, 0)) / Math.max(1, columns.length - 3);
  async function* rows() {
    for await (const e of events()) yield columns.map((c) => registerCell(type!, e, c.key, names, locale));
  }
  const it = (d?: string) => (d ? d.split("-").reverse().join("/") : "…");
  const pdf = await tablePdf({
    title: label(type.name, locale, type.key),
    subtitle: `${ctx.org.name} · ${filters.from || filters.to ? `${it(filters.from)} – ${it(filters.to)}` : t.allPeriod}`,
    columns: columns.map((c) => ({ label: c.label, width: fixed[c.key] ?? rest })),
    rows: rows(),
    empty: t.noEntries,
  });
  return new Response(pdf as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${name}.pdf"` } });
}
