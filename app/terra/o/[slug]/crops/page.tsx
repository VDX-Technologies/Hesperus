import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { canRecord, type Role } from "@/lib/engine/manual";
import { flattenPlaces, placeTree } from "@/lib/engine/places";
import { propertyValues } from "@/lib/engine/registers";
import { CROP_FORM, PHASE_LABELS, PHASES } from "@/lib/packages/agronomy";
import { listCrops } from "@/lib/packages/agronomy/console";
import type { CropInfo } from "@/lib/packages/agronomy/register";
import { SectionTitle } from "@/components/ui";
import { CropForm } from "@/components/terra/modules/agronomy/crop-form";
import { cropAction } from "./actions";

const ERRORS = ["required", "notNumber", "unitRequired", "notDate", "manualErr_403", "manualErr_404", "manualErr_409", "manualErr_429"] as const;

export default async function Crops(props: PageProps<"/terra/o/[slug]/crops">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const { org, role, modules } = await requireOrg(slug);
  if (!modules.some((m) => m.module === "agronomy")) notFound();
  const { t, locale } = await getT();
  const db = tenantDb(org.id);
  const writer = canRecord(role as Role);
  const [crops, tree, { rows: used }] = await Promise.all([
    listCrops(db),
    writer ? placeTree(db) : [],
    db.query<{ object_id: string }>(
      `select distinct eo.object_id from event_objects eo join objects o on o.tenant_id = eo.tenant_id and o.id = eo.object_id
        join object_types ty on ty.id = o.type_id where eo.tenant_id = $1 and ty.module = 'agronomy' and ty.key = 'crop'`,
      [org.id],
    ),
  ]);
  const hasEvents = new Set(used.map((r) => r.object_id));
  const editing = typeof sp.edit === "string" ? crops.find((c) => c.id === sp.edit) : undefined;
  const error = typeof sp.error === "string" && (ERRORS as readonly string[]).includes(sp.error) ? t[sp.error as (typeof ERRORS)[number]] : null;
  const form = (submit: string) => ({
    fieldLabels: Object.fromEntries(Object.entries(CROP_FORM).map(([k, v]) => [k, v.label?.[locale] ?? k])),
    optionLabels: { phase: Object.fromEntries(PHASES.map((p) => [p, PHASE_LABELS[p][locale]])) },
    labels: { submit, pending: t.saving, saved: t.savedShort, choose: t.choose, errors: Object.fromEntries(ERRORS.map((e) => [e, t[e]])) },
    text: { name: t.cropName, place: t.place, noPlace: t.noPlace },
    places: flattenPlaces(tree).map(({ place, path }) => ({ id: place.id, label: path.join(" / ") })),
  });
  const day = (d: string | null) => (d ? d.slice(0, 10).split("-").reverse().join("/") : null);
  const card = (c: CropInfo) => (
    <li key={c.id} className="card p-3 text-sm">
      <Link href={`/terra/o/${slug}/devices/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
      <div className="text-xs text-dim">
        {[c.species, c.variety, c.hectares !== null ? `${String(c.hectares).replace(".", locale === "it" ? "," : ".")} ha` : null, c.phase ? PHASE_LABELS[c.phase][locale] : null, c.placePath.join(" / ")].filter(Boolean).join(" · ")}
      </div>
      {(c.start || c.end) && <div className="text-xs text-dim num">{day(c.start) ?? "…"} – {day(c.end) ?? "…"}</div>}
      {writer && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <Link href={`?edit=${c.id}`} className="text-frost hover:underline">{t.edit}</Link>
          {!c.archived && (
            <form action={cropAction} className="flex items-center gap-1">
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="id" value={c.id} />
              <input type="date" name="end" defaultValue={c.end?.slice(0, 10) ?? ""} aria-label={t.archiveEnd} className="h-7 text-xs" />
              <button name="op" value="archive" className="text-frost hover:underline">{t.archive}</button>
            </form>
          )}
          {!hasEvents.has(c.id) && (
            <form action={cropAction}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="id" value={c.id} />
              <button name="op" value="delete" className="text-red-400 hover:underline">{t.remove}</button>
            </form>
          )}
        </div>
      )}
    </li>
  );
  const active = crops.filter((c) => !c.archived);
  const archived = crops.filter((c) => c.archived);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.crops}</h1>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {writer && editing && (
        <section className="card mt-6 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">{t.edit} · {editing.name}</h2>
            <Link href={`/terra/o/${slug}/crops`} className="text-xs text-dim hover:underline">{t.cancel}</Link>
          </div>
          <CropForm key={editing.id} slug={slug} id={editing.id} initial={propertyValues(CROP_FORM, (await db.query<{ properties: Record<string, unknown> }>(`select properties from objects where tenant_id = $1 and id = $2`, [org.id, editing.id])).rows[0]?.properties ?? {})} {...form(t.save)} />
        </section>
      )}
      <SectionTitle>{t.activeCrops}</SectionTitle>
      {active.length ? <ul className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{active.map(card)}</ul> : <p className="mb-4 text-sm text-dim">{t.noCrops}</p>}
      {writer && !editing && (
        <details className="card p-4" open={!crops.length}>
          <summary className="cursor-pointer text-sm font-medium">{t.newCrop}</summary>
          <div className="mt-4"><CropForm slug={slug} {...form(t.save)} /></div>
        </details>
      )}
      {archived.length > 0 && (
        <>
          <SectionTitle>{t.archivedCrops}</SectionTitle>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{archived.map(card)}</ul>
        </>
      )}
    </div>
  );
}
