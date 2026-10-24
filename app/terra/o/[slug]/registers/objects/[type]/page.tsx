import Link from "next/link";
import { notFound } from "next/navigation";
import { getT, type Dict } from "@/lib/i18n";
import { canRecord } from "@/lib/engine/manual";
import { fieldText, label, propertyValues, subjectObjects, subjectTypes } from "@/lib/engine/registers";
import { getObject, getObjectType, listObjects } from "@/lib/engine/custom-objects";
import { EventForm } from "@/components/terra/event-form";
import { ConfirmButton } from "@/components/confirm-button";
import { deleteObjectAction, saveObjectAction } from "../../actions";
import { registerContext } from "../../context";

const ERRORS = ["required", "notNumber", "unitRequired", "notDate", "notJson", "manualErr_403", "manualErr_404", "manualErr_409", "manualErr_429"] as const;

/** The objects of one custom type: a list with their properties and links, and the form to add or change one. */
export default async function Objects(props: PageProps<"/terra/o/[slug]/registers/objects/[type]">) {
  const { slug, type: param } = await props.params;
  const sp = await props.searchParams;
  const ctx = await registerContext(slug);
  const type = await getObjectType(ctx.db, decodeURIComponent(param));
  if (!type) notFound();
  const { t, locale } = await getT();
  const writer = canRecord(ctx.author.role);
  const editId = typeof sp.edit === "string" ? sp.edit : "";
  const links = Object.entries(type.links);

  const [objects, targets, types, editing] = await Promise.all([
    listObjects(ctx.db, type.type),
    Promise.all(links.map(([, l]) => subjectObjects(ctx.db, l.type, { all: true }))),
    links.length ? subjectTypes(ctx.db) : [],
    writer && editId ? getObject(ctx.db, editId) : null,
  ]);
  const edit = editing && editing.type === type.type ? editing : null;
  const names = new Map(targets.flat().map((o) => [o.id, o.name]));
  const error = typeof sp.error === "string" && sp.error in t ? t[sp.error as keyof Dict] : null;
  const base = `/terra/o/${slug}/registers/objects/${encodeURIComponent(type.type)}`;
  const props_ = Object.entries(type.properties);
  const linkLabel = (k: string, l: (typeof links)[number][1]) => label(l.label, locale, label(types.find((s) => s.type === l.type)?.name, locale, k));

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{label(type.name, locale, type.key)}</h1>
        <div className="flex gap-3 text-xs">
          <Link href={`/terra/o/${slug}/registers/objects`} className="text-dim hover:underline">← {t.objectTypes}</Link>
          {ctx.author.role === "owner" && <Link href={`/terra/o/${slug}/registers/types?kind=object&key=${type.key}`} className="text-frost hover:underline">{t.editObjectType}</Link>}
        </div>
      </div>

      {sp.saved && <p className="mt-4 rounded-lg border border-ok/40 bg-ok/10 px-4 py-2.5 text-sm">{t.savedShort}</p>}
      {error && <p className="mt-4 rounded-lg border border-alarm/40 bg-alarm/10 px-4 py-2.5 text-sm">{error}</p>}

      {writer && (
        <section id="new" className="card mt-6 scroll-mt-20 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium">{edit ? t.editObject : t.newObject}</h2>
            {edit && <Link href={base} className="text-xs text-dim hover:underline">{t.cancel}</Link>}
          </div>
          <EventForm
            key={edit ? edit.id : "new"}
            schema={type.properties}
            action={saveObjectAction}
            hidden={{ slug, type: type.type, id: edit?.id ?? "" }}
            initial={edit ? propertyValues(type.properties, edit.properties) : undefined}
            fieldLabels={Object.fromEntries(props_.map(([k, s]) => [k, label(s.label, locale, k)]))}
            optionLabels={Object.fromEntries(props_.filter(([, s]) => s.options).map(([k, s]) => [k, Object.fromEntries(Object.entries(s.options!).map(([o, l]) => [o, label(l, locale, o)]))]))}
            labels={{ submit: t.save, pending: t.saving, saved: t.savedShort, choose: t.choose, errors: Object.fromEntries(ERRORS.map((e) => [e, t[e]])) }}
            before={
              <div className="grid gap-4 text-sm sm:grid-cols-2">
                <label className="block"><span className="text-dim">{t.objectName}</span>
                  <input name="_name" defaultValue={edit?.name ?? ""} className="mt-1 w-full" /></label>
                {!edit && (
                  <label className="block"><span className="text-dim">{t.externalId}</span>
                    <input name="_external" className="mt-1 w-full" /></label>
                )}
                {links.map(([k, l], i) => (
                  <label key={k} className="block"><span className="text-dim">{linkLabel(k, l)}{l.required ? " *" : ""}</span>
                    <select name={`_link.${k}`} defaultValue={edit?.links[k] ?? ""} required={l.required} className="mt-1 w-full">
                      <option value="">{t.choose}</option>
                      {targets[i].map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select></label>
                ))}
              </div>
            }
          />
        </section>
      )}

      <h2 className="mt-8 mb-3 text-sm font-medium">{t.objects} · <span className="num">{objects.length}</span></h2>
      {objects.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-dim">
                <th className="px-2 py-2 font-normal">{t.objectName}</th>
                {links.map(([k, l]) => <th key={k} className="px-2 py-2 font-normal">{linkLabel(k, l)}</th>)}
                {props_.map(([k, s]) => <th key={k} className="px-2 py-2 font-normal">{label(s.label, locale, k)}</th>)}
                {writer && <th />}
              </tr>
            </thead>
            <tbody>
              {objects.map((o) => (
                <tr key={o.id} className="border-t border-line align-top">
                  <td className="px-2 py-2">
                    {o.name}
                    {o.externalId && o.externalId !== o.name && <div className="text-[11px] text-dim">{o.externalId}</div>}
                  </td>
                  {links.map(([k]) => <td key={k} className="px-2 py-2">{o.links[k] ? names.get(o.links[k]) ?? "–" : ""}</td>)}
                  {props_.map(([k, s]) => <td key={k} className="max-w-xs truncate px-2 py-2">{fieldText(s, o.properties[k], locale)}</td>)}
                  {writer && (
                    <td className="px-2 py-2 text-right">
                      <Link href={`${base}?edit=${o.id}#new`} className="text-xs text-frost hover:underline">{t.editObject}</Link>
                      <form action={deleteObjectAction} className="mt-1">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="type" value={type.type} />
                        <input type="hidden" name="id" value={o.id} />
                        <ConfirmButton message={t.deleteObjectConfirm} className="text-xs text-alarm hover:underline">{t.deleteObject}</ConfirmButton>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-dim">{t.noObjectsOfType}</p>
      )}
    </div>
  );
}
