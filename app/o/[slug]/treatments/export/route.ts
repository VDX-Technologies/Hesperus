// The register as PDF (paper layout), CSV or JSON, with the same filters as the page.
import { requireOrg } from "@/lib/auth";
import { tenantDb } from "@/lib/engine/db";
import { getT } from "@/lib/i18n";
import { listTreatments } from "@/lib/packages/agronomy/console";
import { registerCsv, registerJson } from "@/lib/packages/agronomy/register";
import { registerPdf } from "@/lib/packages/agronomy/pdf";
import { filtersFrom } from "../filters";

export async function GET(req: Request, ctx: RouteContext<"/o/[slug]/treatments/export">) {
  const { slug } = await ctx.params;
  const { org, modules } = await requireOrg(slug);
  if (!modules.some((m) => m.module === "agronomy")) return new Response("not found", { status: 404 });
  const { locale } = await getT();
  const q = new URL(req.url).searchParams;
  const f = filtersFrom((k) => q.get(k));
  const rows = await listTreatments(tenantDb(org.id), f, undefined, 10000);
  const name = `registro-trattamenti-${slug}-${new Date().toISOString().slice(0, 10)}`;
  const format = q.get("format");
  if (format === "csv")
    return new Response(registerCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"` } });
  if (format === "json")
    return Response.json(registerJson(rows, { organization: org.name, from: f.from ?? null, to: f.to ?? null, generatedAt: new Date() }), {
      headers: { "content-disposition": `attachment; filename="${name}.json"` },
    });
  const it = (d?: string) => (d ? d.split("-").reverse().join("/") : "…");
  const period = f.from || f.to ? `${it(f.from)} – ${it(f.to)}` : locale === "it" ? "tutti i trattamenti" : "all treatments";
  const pdf = await registerPdf([...rows].reverse(), { organization: org.name, period, locale });
  return new Response(pdf as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${name}.pdf"` } });
}
