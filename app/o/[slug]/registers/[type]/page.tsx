import Link from "next/link";
import { notFound } from "next/navigation";
import { getT, type Dict } from "@/lib/i18n";
import { cursorOf, getEvent, lastEventBy, listEvents, parseCursor } from "@/lib/engine/events";
import { canRecord } from "@/lib/engine/manual";
import {
  eventValues, fieldSuggestions, filterParams, filterable, filtersFrom, formSchema, label, registerCell, registerColumns, registerQuery,
  subjectObjects, subjectValues, type EventTypeInfo, type Locale,
} from "@/lib/engine/registers";
import { exportsOf } from "@/lib/packages/exports";
import { SectionTitle } from "@/components/ui";
import { RegisterForm } from "@/components/registers/register-form";
import { registerContext, typeFrom } from "../context";

const PAGE = 50;
const ERRORS = ["required", "notNumber", "unitRequired", "notDate", "objectRequired", "manualErr_403", "manualErr_404", "manualErr_409", "manualErr_429"] as const;

function formText(t: Dict, type: EventTypeInfo, locale: Locale, submit: string) {
  const schema = formSchema(type);
  return {
    fieldLabels: Object.fromEntries(Object.entries(schema).map(([k, s]) => [k, label(s.label, locale, k)])),
    optionLabels: Object.fromEntries(Object.entries(schema).filter(([, s]) => s.options).map(([k, s]) => [k, Object.fromEntries(Object.entries(s.options!).map(([o, l]) => [o, label(l, locale, o)]))])),
    labels: { submit, pending: t.saving, saved: t.savedShort, choose: t.choose, errors: Object.fromEntries(ERRORS.map((e) => [e, t[e]])) },
  };
}

export default async function Register(props: PageProps<"/o/[slug]/registers/[type]">) {
  const { slug, type: param } = await props.params;
  const sp = await props.searchParams;
  const ctx = await registerContext(slug);
  const type = await typeFrom(ctx, param);
  if (!type) notFound();
  const { t, locale } = await getT();
  const writer = canRecord(ctx.author.role);
  const f = filtersFrom(type, sp);
  const after = parseCursor(typeof sp.after === "string" ? sp.after : undefined);
  const editId = Number(sp.edit) || 0;

  const [page, objects, sugg, last, editing] = await Promise.all([
    listEvents(ctx.db, { ...registerQuery(type, f), after, limit: PAGE + 1 }),
    subjectObjects(ctx.db, type.subject, { all: true }),
    fieldSuggestions(ctx.db, type),
    writer ? lastEventBy(ctx.db, ctx.user.id, type.type) : null,
    writer && editId ? getEvent(ctx.db, editId) : null,
  ]);
  const rows = page.slice(0, PAGE);
  const more = page.length > PAGE;
  const names = new Map(objects.map((o) => [o.id, o.name]));
  const active = objects.filter((o) => !o.archived);
  const edit = editing && editing.type === type.type ? editing : null;
  const columns = registerColumns(type, locale, { date: t.date, object: t.object, author: t.recordedBy });
  const base = `/o/${slug}/registers/${encodeURIComponent(type.type)}`;
  const query = filterParams(f).toString();
  const withQuery = (extra: Record<string, string>) => {
    const p = filterParams(f);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `${base}?${p}`;
  };
  const name = label(type.name, locale, type.key);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
        <div className="flex gap-3 text-xs">
          <Link href={`/o/${slug}/registers`} className="text-dim hover:underline">← {t.registers}</Link>
          {type.custom && ctx.author.role === "owner" && <Link href={`/o/${slug}/registers/types?key=${type.key}`} className="text-frost hover:underline">{t.editType}</Link>}
        </div>
      </div>

      {writer && (
        <section className="card mt-6 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">{edit ? t.correctEntry : t.newEntry}</h2>
            {edit && <Link href={base} className="text-xs text-dim hover:underline">{t.cancel}</Link>}
          </div>
          {edit && <p className="mb-3 text-xs text-dim">{t.correctionOf}</p>}
          {active.length ? (
            <RegisterForm
              key={edit ? `e${edit.id}` : "new"}
              slug={slug}
              type={type.type}
              schema={formSchema(type)}
              objects={active.map((o) => ({ id: o.id, label: o.name, values: subjectValues(type, o) }))}
              last={last ? eventValues(type, last) : null}
              initial={edit ? eventValues(type, edit) : undefined}
              editId={edit?.id}
              suggestions={sugg}
              {...formText(t, type, locale, edit ? t.correct : t.save)}
              text={{ object: t.object, repeatLast: t.repeatLast, comma: t.decimalHintGeneric }}
            />
          ) : (
            <p className="text-sm text-dim">{t.noObjects}</p>
          )}
        </section>
      )}

      <SectionTitle>{t.entries}</SectionTitle>
      <form className="mb-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-6" method="get">
        <select name="obj" defaultValue={f.obj ?? ""} className="col-span-2 sm:col-span-1">
          <option value="">{t.allObjects}</option>
          {objects.map((o) => <option key={o.id} value={o.id}>{o.name}{o.archived ? ` (${t.archived})` : ""}</option>)}
        </select>
        {Object.entries(type.fields).filter(([, s]) => filterable(s)).map(([k, s]) => {
          const ph = label(s.label, locale, k);
          if (s.enum || s.type === "boolean") {
            const opts = s.type === "boolean" ? [["true", t.yes], ["false", t.no]] : s.enum!.map((o) => [String(o), label(s.options?.[String(o)], locale, String(o))]);
            return (
              <select key={k} name={`f.${k}`} defaultValue={f.fields[k] ?? ""}>
                <option value="">{ph}</option>
                {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            );
          }
          return (
            <span key={k}>
              <input name={`f.${k}`} defaultValue={f.fields[k] ?? ""} placeholder={ph} list={sugg[k] ? `f-${k}` : undefined} autoComplete="off" className="w-full" />
              {sugg[k] && <datalist id={`f-${k}`}>{sugg[k].map((v) => <option key={v} value={v} />)}</datalist>}
            </span>
          );
        })}
        <label className="flex items-center gap-1"><span className="text-dim">{t.dateFrom}</span><input type="date" name="from" defaultValue={f.from ?? ""} className="min-w-0 flex-1" /></label>
        <label className="flex items-center gap-1"><span className="text-dim">{t.dateTo}</span><input type="date" name="to" defaultValue={f.to ?? ""} className="min-w-0 flex-1" /></label>
        <div className="col-span-2 flex gap-2 sm:col-span-1">
          <button className="btn flex-1">{t.filter}</button>
          {query && <Link href={base} className="btn">{t.clearFilters}</Link>}
        </div>
      </form>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {[{ id: "pdf", label: "PDF" }, { id: "csv", label: "CSV" }, ...exportsOf(type.type).map((x) => ({ id: x.id, label: x.label[locale] }))].map((x) => (
          <a key={x.id} href={`${base}/export?format=${x.id}${query ? `&${query}` : ""}`} className="btn">{x.label}</a>
        ))}
      </div>

      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-dim">
                {columns.map((c) => <th key={c.key} className="px-2 py-2 font-normal">{c.label}</th>)}
                {writer && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-t border-line align-top">
                  {columns.map((c) => <td key={c.key} className="px-2 py-2">{registerCell(type, e, c.key, names, locale)}</td>)}
                  {writer && (
                    <td className="px-2 py-2 text-right">
                      {e.author && <Link href={withQuery({ edit: String(e.id) })} className="text-xs text-frost hover:underline">{t.correct}</Link>}
                      {e.version > 1 && <div className="text-[11px] text-dim">{t.version} {e.version}</div>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-dim">{t.noEntries}</p>
      )}
      <div className="mt-4 flex gap-3 text-sm">
        {after && <Link href={query ? `${base}?${query}` : base} className="btn">{t.firstPage}</Link>}
        {more && <Link href={withQuery({ after: cursorOf(rows[rows.length - 1]) })} className="btn">{t.nextPage} →</Link>}
      </div>
    </div>
  );
}
