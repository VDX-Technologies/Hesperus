"use client";
// The schema editor for a custom type, of events (a register) or of objects (a project, a
// dataset, a result). Name and fields for both; an event type adds what it is recorded on, an
// object type its links to other types. Builds the definition the server validates
// (checkEventType, checkObjectType) and saves; the type is usable at once.
import { useActionState, useState } from "react";
import type { EventFormState } from "@/components/event-form";
import type { EventTypeInput } from "@/lib/engine/registers";
import type { ObjectTypeInput } from "@/lib/engine/custom-objects";
import type { Schema } from "@/lib/engine/schema";

export interface FieldDraft {
  key: string; label: string; type: string; required: boolean; units: string; options: string; fromSubject: string;
  /** Object types only: the property holds a field schema, or follows one read through a link. */
  holdsSchema?: boolean; schemaFrom?: string;
  /** A string field written on several lines. */
  multiline?: boolean;
}
export interface LinkDraft { key: string; type: string; required: boolean }
export interface TypeDraft {
  key: string; name: { it: string; en: string }; subject: string; fields: FieldDraft[];
  also?: string[]; links?: LinkDraft[];
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const blank = (): FieldDraft => ({ key: "", label: "", type: "string", required: false, units: "", options: "", fromSubject: "" });

function toSchema(d: TypeDraft, locale: string, object: boolean): Schema {
  const fields: Schema = {};
  for (const f of d.fields) {
    const options = list(f.options);
    fields[f.key] = {
      type: f.type as Schema[string]["type"],
      ...(f.required ? { required: true } : {}),
      ...(f.label ? { label: { [locale]: f.label } } : {}),
      ...(f.type === "quantity" ? { units: list(f.units) } : {}),
      ...(f.type === "string" && options.length ? { enum: options } : {}),
      ...(f.type === "string" && !options.length && f.multiline ? { format: "text" as const } : {}),
      ...(object && f.type === "object" && f.holdsSchema ? { format: "schema" as const } : {}),
      ...(object && f.type === "object" && !f.holdsSchema && f.schemaFrom?.trim() ? { schemaFrom: f.schemaFrom.trim() } : {}),
    };
  }
  return fields;
}

const names = (d: TypeDraft) => Object.fromEntries(Object.entries(d.name).filter(([, v]) => v.trim()));

export function toDefinition(d: TypeDraft, locale: string): EventTypeInput {
  const fromSubject = Object.fromEntries(d.fields.filter((f) => f.fromSubject).map((f) => [f.key, f.fromSubject]));
  return { key: d.key, name: names(d), subject: d.subject, fields: toSchema(d, locale, false), fromSubject, also: d.also ?? [] };
}

export function toObjectDefinition(d: TypeDraft, locale: string): ObjectTypeInput {
  const links = Object.fromEntries((d.links ?? []).filter((l) => l.key).map((l) => [l.key, { type: l.type, ...(l.required ? { required: true } : {}) }]));
  return { key: d.key, name: names(d), properties: toSchema(d, locale, true), links };
}

type Text = Record<
  | "key" | "nameIt" | "nameEn" | "subject" | "fields" | "addField" | "remove" | "fieldKey" | "fieldLabel" | "fieldType"
  | "required" | "units" | "options" | "fromSubject" | "save" | "choose" | "also" | "links" | "addLink" | "linkType"
  | "holdsSchema" | "schemaFrom" | "multiline",
  string
>;

export function TypeEditor({ slug, action: save, locale, kind = "event", initial, subjects, fieldTypes, text }: {
  slug: string;
  /** The console's server action that saves the definition and opens the type. */
  action: (prev: EventFormState, form: FormData) => Promise<EventFormState>;
  locale: string;
  kind?: "event" | "object";
  initial?: TypeDraft;
  /** Object types an event can be recorded on, or an object type can link to. */
  subjects: { value: string; label: string }[];
  fieldTypes: string[];
  text: Text;
}) {
  const object = kind === "object";
  const [d, setD] = useState<TypeDraft>(initial ?? { key: "", name: { it: "", en: "" }, subject: "", fields: [blank()], also: [], links: [] });
  const [state, action, pending] = useActionState<EventFormState, FormData>(save, {});
  const setField = (i: number, patch: Partial<FieldDraft>) => setD((s) => ({ ...s, fields: s.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const links = d.links ?? [];
  const setLink = (i: number, patch: Partial<LinkDraft>) => setD((s) => ({ ...s, links: links.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const input = "mt-1 w-full";
  const definition = object ? toObjectDefinition(d, locale) : toDefinition(d, locale);
  return (
    <form action={action} className="space-y-4 text-sm">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="definition" value={JSON.stringify(definition)} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="text-dim">{text.key} *</span>
          <input value={d.key} readOnly={!!initial} onChange={(e) => setD({ ...d, key: e.target.value })} pattern="[a-z][a-z0-9_]{0,39}" required className={input} /></label>
        {!object && (
          <label className="block"><span className="text-dim">{text.subject} *</span>
            <select value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value, also: (d.also ?? []).filter((a) => a !== e.target.value) })} required className={input}>
              <option value="">{text.choose}</option>
              {subjects.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select></label>
        )}
        <label className="block"><span className="text-dim">{text.nameIt}</span>
          <input value={d.name.it} onChange={(e) => setD({ ...d, name: { ...d.name, it: e.target.value } })} className={input} /></label>
        <label className="block"><span className="text-dim">{text.nameEn}</span>
          <input value={d.name.en} onChange={(e) => setD({ ...d, name: { ...d.name, en: e.target.value } })} className={input} /></label>
      </div>
      {!object && d.subject && (
        <fieldset>
          <legend className="text-dim">{text.also}</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {subjects.filter((s) => s.value !== d.subject).map((s) => (
              <label key={s.value} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={(d.also ?? []).includes(s.value)}
                  onChange={(e) => setD({ ...d, also: e.target.checked ? [...(d.also ?? []), s.value] : (d.also ?? []).filter((a) => a !== s.value) })}
                />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset className="space-y-3">
        <legend className="text-dim">{text.fields}</legend>
        {d.fields.map((f, i) => (
          <div key={i} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-3">
            <input aria-label={text.fieldKey} placeholder={text.fieldKey} value={f.key} onChange={(e) => setField(i, { key: e.target.value })} required />
            <input aria-label={text.fieldLabel} placeholder={text.fieldLabel} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
            <select aria-label={text.fieldType} value={f.type} onChange={(e) => setField(i, { type: e.target.value })}>
              {fieldTypes.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            {f.type === "quantity" && <input aria-label={text.units} placeholder={`${text.units} (kg, l)`} value={f.units} onChange={(e) => setField(i, { units: e.target.value })} required />}
            {f.type === "string" && <input aria-label={text.options} placeholder={text.options} value={f.options} onChange={(e) => setField(i, { options: e.target.value })} />}
            {f.type === "string" && !f.options.trim() && (
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.multiline} onChange={(e) => setField(i, { multiline: e.target.checked })} /> {text.multiline}</label>
            )}
            {!object && <input aria-label={text.fromSubject} placeholder={text.fromSubject} value={f.fromSubject} onChange={(e) => setField(i, { fromSubject: e.target.value })} />}
            {object && f.type === "object" && (
              <>
                <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.holdsSchema} onChange={(e) => setField(i, { holdsSchema: e.target.checked })} /> {text.holdsSchema}</label>
                {!f.holdsSchema && <input aria-label={text.schemaFrom} placeholder={text.schemaFrom} value={f.schemaFrom ?? ""} onChange={(e) => setField(i, { schemaFrom: e.target.value })} />}
              </>
            )}
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> {text.required}</label>
            <button type="button" onClick={() => setD({ ...d, fields: d.fields.filter((_, j) => j !== i) })} className="text-left text-xs text-dim hover:underline">{text.remove}</button>
          </div>
        ))}
        <button type="button" onClick={() => setD({ ...d, fields: [...d.fields, blank()] })} className="text-xs text-frost hover:underline">+ {text.addField}</button>
      </fieldset>
      {object && (
        <fieldset className="space-y-3">
          <legend className="text-dim">{text.links}</legend>
          {links.map((l, i) => (
            <div key={i} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-4">
              <input aria-label={text.fieldKey} placeholder={text.fieldKey} value={l.key} onChange={(e) => setLink(i, { key: e.target.value })} pattern="[a-z][a-z0-9_]{0,39}" required />
              <select aria-label={text.linkType} value={l.type} onChange={(e) => setLink(i, { type: e.target.value })} required>
                <option value="">{text.linkType}…</option>
                {subjects.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              <label className="flex items-center gap-2"><input type="checkbox" checked={l.required} onChange={(e) => setLink(i, { required: e.target.checked })} /> {text.required}</label>
              <button type="button" onClick={() => setD({ ...d, links: links.filter((_, j) => j !== i) })} className="text-left text-xs text-dim hover:underline">{text.remove}</button>
            </div>
          ))}
          <button type="button" onClick={() => setD({ ...d, links: [...links, { key: "", type: "", required: false }] })} className="text-xs text-frost hover:underline">+ {text.addLink}</button>
        </fieldset>
      )}
      {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
      <button disabled={pending} className="h-11 rounded-lg bg-frost px-5 font-medium text-ink disabled:opacity-50">{text.save}</button>
    </form>
  );
}
