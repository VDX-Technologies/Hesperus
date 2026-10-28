import "server-only";
import { allEvents } from "../../engine/events";
import { registerQuery, type RegisterFilters } from "../../engine/registers";
import type { ExportContext, RegisterExport } from "../exports";
import { TREATMENT, listCrops } from "./console";
import { registerPdf } from "./pdf";
import { registerJson, toRegisterRow } from "./register";

async function* rows(ctx: ExportContext) {
  const crops = new Map((await listCrops(ctx.db)).map((c) => [c.id, c]));
  for await (const e of allEvents(ctx.db, { ...registerQuery(ctx.type, ctx.filters), asc: true })) yield toRegisterRow(e, crops);
}

const period = (f: RegisterFilters, locale: "en" | "it") => {
  const it = (d?: string) => (d ? d.split("-").reverse().join("/") : "…");
  return f.from || f.to ? `${it(f.from)} – ${it(f.to)}` : locale === "it" ? "tutti i trattamenti" : "all treatments";
};

export const agronomyExports: RegisterExport[] = [
  {
    type: TREATMENT,
    id: "legal",
    label: { en: "Official PDF", it: "PDF ufficiale" },
    async run(ctx) {
      const pdf = await registerPdf(rows(ctx), { organization: ctx.organization, period: period(ctx.filters, ctx.locale), locale: ctx.locale });
      return new Response(pdf as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${ctx.name}-ufficiale.pdf"` } });
    },
  },
  {
    type: TREATMENT,
    id: "json",
    label: { en: "JSON", it: "JSON" },
    async run(ctx) {
      const list = [];
      for await (const r of rows(ctx)) list.push(r);
      return Response.json(registerJson(list, { organization: ctx.organization, from: ctx.filters.from ?? null, to: ctx.filters.to ?? null, generatedAt: new Date() }), {
        headers: { "content-disposition": `attachment; filename="${ctx.name}.json"` },
      });
    },
  },
];
