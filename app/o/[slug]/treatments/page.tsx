import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { getT, type Dict } from "@/lib/i18n";
import { tenantDb } from "@/lib/engine/db";
import { getEvent, lastEventBy } from "@/lib/engine/events";
import { canRecord, type Role } from "@/lib/engine/manual";
import { flattenPlaces, placeTree } from "@/lib/engine/places";
import { CROP_PROPERTIES, PHASE_LABELS, PHASES } from "@/lib/packages/agronomy";
import { TREATMENT, listCrops, listTreatments, suggestions } from "@/lib/packages/agronomy/console";
import { TREATMENT_FORM, treatmentValues } from "@/lib/packages/agronomy/form";
import type { Locale } from "@/lib/packages/types";
import { SectionTitle } from "@/components/ui";
import { TreatmentForm } from "@/components/modules/agronomy/treatment-form";
import { CropForm } from "@/components/modules/agronomy/crop-form";
import { TreatmentRows } from "@/components/modules/agronomy/rows";
import { filterQuery, filtersFrom } from "./filters";

const ERRORS = ["required", "notNumber", "unitRequired", "notDate", "cropRequired", "manualErr_403", "manualErr_404", "manualErr_409", "manualErr_429"] as const;

function formText(t: Dict, locale: Locale, submit: string) {
  const labels = (s: Record<string, { label?: Record<string, string> }>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.label?.[locale] ?? k]));
  return {
    fieldLabels: { ...labels(TREATMENT_FORM), ...labels(CROP_PROPERTIES) },
    optionLabels: { phase: Object.fromEntries(PHASES.map((p) => [p, PHASE_LABELS[p][locale]])) },
    labels: { submit, pending: t.saving, saved: t.savedShort, choose: t.choose, errors: Object.fromEntries(ERRORS.map((e) => [e, t[e]])) },
  };
}

export default async function Treatments(props: PageProps<"/o/[slug]/treatments">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const { user, org, role, modules } = await requireOrg(slug);
  if (!modules.some((m) => m.module === "agronomy")) notFound();
  const { t, locale } = await getT();
  const db = tenantDb(org.id);
  const f = filtersFrom((k) => sp[k]);
  const editId = Number(sp.edit) || 0;
  const writer = canRecord(role as Role);

  const crops = await listCrops(db);
  const [rows, sugg, last, editing, tree] = await Promise.all([
    listTreatments(db, f, crops),
    suggestions(db),
    writer ? lastEventBy(db, user.id, TREATMENT) : null,
    writer && editId ? getEvent(db, editId) : null,
    writer ? placeTree(db) : [],
  ]);
  const edit = editing && editing.type === TREATMENT ? editing : null;
  const options = crops.map((c) => ({ id: c.id, label: [c.name, c.variety, c.placePath.join(" / ")].filter(Boolean).join(" · "), hectares: c.hectares, phase: c.phase }));
  const query = filterQuery(f);
  const base = `/o/${slug}/treatments`;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.treatmentsRegister}</h1>

      {writer && crops.length > 0 && (
        <section className="card mt-6 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">{edit ? t.correctTreatment : t.newTreatment}</h2>
            {edit && <Link href={base} className="text-xs text-dim hover:underline">{t.cancel}</Link>}
          </div>
          {edit && <p className="mb-3 text-xs text-dim">{t.correctionOf}</p>}
          <TreatmentForm
            key={edit ? `e${edit.id}` : "new"}
            slug={slug}
            crops={options}
            last={last ? treatmentValues(last) : null}
            initial={edit ? treatmentValues(edit) : undefined}
            editId={edit?.id}
            suggestions={sugg}
            {...formText(t, locale, edit ? t.correct : t.save)}
            text={{ crop: t.crop, repeatLast: t.repeatLast, comma: t.decimalHint }}
          />
        </section>
      )}

      <SectionTitle>{t.treatments}</SectionTitle>
      <form className="mb-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-6" method="get">
        <select name="crop" defaultValue={f.cropId ?? ""} className="col-span-2 sm:col-span-1">
          <option value="">{t.allCrops}</option>
          {options.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <input name="product" defaultValue={f.product ?? ""} placeholder={TREATMENT_FORM.product.label![locale]} list="f-product" autoComplete="off" />
        <input name="adversity" defaultValue={f.adversity ?? ""} placeholder={TREATMENT_FORM.adversity.label![locale]} list="f-adversity" autoComplete="off" />
        <datalist id="f-product">{sugg.product.map((s) => <option key={s} value={s} />)}</datalist>
        <datalist id="f-adversity">{sugg.adversity.map((s) => <option key={s} value={s} />)}</datalist>
        <label className="flex items-center gap-1"><span className="text-dim">{t.dateFrom}</span><input type="date" name="from" defaultValue={f.from ?? ""} className="min-w-0 flex-1" /></label>
        <label className="flex items-center gap-1"><span className="text-dim">{t.dateTo}</span><input type="date" name="to" defaultValue={f.to ?? ""} className="min-w-0 flex-1" /></label>
        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <button className="btn flex-1">{t.filter}</button>
          {query && <Link href={base} className="btn">{t.clearFilters}</Link>}
        </div>
      </form>
      <div className="mb-3 flex gap-2 text-xs">
        {(["pdf", "csv", "json"] as const).map((x) => (
          <a key={x} href={`${base}/export?format=${x}${query ? `&${query}` : ""}`} className="btn">{x.toUpperCase()}</a>
        ))}
      </div>
      <TreatmentRows rows={rows} locale={locale} t={t} editHref={writer ? (r) => `${base}?edit=${r.id}${query ? `&${query}` : ""}` : undefined} />

      <SectionTitle>{t.crops}</SectionTitle>
      {crops.length ? (
        <ul className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {crops.map((c) => (
            <li key={c.id}>
              <Link href={`/o/${slug}/devices/${c.id}`} className="card block p-3 text-sm hover:border-frost">
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-dim">
                  {[c.species, c.variety, c.hectares !== null ? `${String(c.hectares).replace(".", locale === "it" ? "," : ".")} ha` : null, c.phase ? PHASE_LABELS[c.phase][locale] : null, c.placePath.join(" / ")].filter(Boolean).join(" · ")}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-dim">{t.noCrops}</p>
      )}
      {writer && (
        <details className="card p-4" open={!crops.length}>
          <summary className="cursor-pointer text-sm font-medium">{t.newCrop}</summary>
          <div className="mt-4">
            <CropForm
              slug={slug}
              places={flattenPlaces(tree).map(({ place, path }) => ({ id: place.id, label: path.join(" / ") }))}
              {...formText(t, locale, t.save)}
              text={{ name: t.cropName, place: t.place, noPlace: t.noPlace }}
            />
          </div>
        </details>
      )}
    </div>
  );
}
