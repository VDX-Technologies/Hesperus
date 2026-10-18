"use client";
// The schema editor for a custom event type: name, what it is recorded on, its fields. Builds
// the definition the server validates (checkEventType) and saves; the register exists at once.
import { useActionState, useState } from "react";
import type { EventFormState } from "@/components/event-form";
import type { EventTypeInput } from "@/lib/engine/registers";
import type { Schema } from "@/lib/engine/schema";
import { saveType } from "@/app/o/[slug]/registers/actions";

export interface FieldDraft { key: string; label: string; type: string; required: boolean; units: string; options: string; fromSubject: string }
export interface TypeDraft { key: string; name: { it: string; en: string }; subject: string; fields: FieldDraft[] }

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const blank = (): FieldDraft => ({ key: "", label: "", type: "string", required: false, units: "", options: "", fromSubject: "" });

export function toDefinition(d: TypeDraft, locale: string): EventTypeInput {
  const fields: Schema = {};
  const fromSubject: Record<string, string> = {};
  for (const f of d.fields) {
    const options = list(f.options);
    fields[f.key] = {
      type: f.type as Schema[string]["type"],
      ...(f.required ? { required: true } : {}),
      ...(f.label ? { label: { [locale]: f.label } } : {}),
      ...(f.type === "quantity" ? { units: list(f.units) } : {}),
      ...(f.type === "string" && options.length ? { enum: options } : {}),
    };
    if (f.fromSubject) fromSubject[f.key] = f.fromSubject;
  }
  const name = Object.fromEntries(Object.entries(d.name).filter(([, v]) => v.trim()));
  return { key: d.key, name, subject: d.subject, fields, fromSubject };
}

export function TypeEditor({ slug, locale, initial, subjects, fieldTypes, text }: {
  slug: string;
  locale: string;
  initial?: TypeDraft;
  subjects: { value: string; label: string }[];
  fieldTypes: string[];
  text: Record<"key" | "nameIt" | "nameEn" | "subject" | "fields" | "addField" | "remove" | "fieldKey" | "fieldLabel" | "fieldType" | "required" | "units" | "options" | "fromSubject" | "save" | "choose", string>;
}) {
  const [d, setD] = useState<TypeDraft>(initial ?? { key: "", name: { it: "", en: "" }, subject: "", fields: [blank()] });
  const [state, action, pending] = useActionState<EventFormState, FormData>(saveType, {});
  const setField = (i: number, patch: Partial<FieldDraft>) => setD((s) => ({ ...s, fields: s.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const input = "mt-1 w-full";
  return (
    <form action={action} className="space-y-4 text-sm">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="definition" value={JSON.stringify(toDefinition(d, locale))} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="text-dim">{text.key} *</span>
          <input value={d.key} readOnly={!!initial} onChange={(e) => setD({ ...d, key: e.target.value })} pattern="[a-z][a-z0-9_]{0,39}" required className={input} /></label>
        <label className="block"><span className="text-dim">{text.subject} *</span>
          <select value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} required className={input}>
            <option value="">{text.choose}</option>
            {subjects.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select></label>
        <label className="block"><span className="text-dim">{text.nameIt}</span>
          <input value={d.name.it} onChange={(e) => setD({ ...d, name: { ...d.name, it: e.target.value } })} className={input} /></label>
        <label className="block"><span className="text-dim">{text.nameEn}</span>
          <input value={d.name.en} onChange={(e) => setD({ ...d, name: { ...d.name, en: e.target.value } })} className={input} /></label>
      </div>
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
            <input aria-label={text.fromSubject} placeholder={text.fromSubject} value={f.fromSubject} onChange={(e) => setField(i, { fromSubject: e.target.value })} />
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> {text.required}</label>
            <button type="button" onClick={() => setD({ ...d, fields: d.fields.filter((_, j) => j !== i) })} className="text-left text-xs text-dim hover:underline">{text.remove}</button>
          </div>
        ))}
        <button type="button" onClick={() => setD({ ...d, fields: [...d.fields, blank()] })} className="text-xs text-frost hover:underline">+ {text.addField}</button>
      </fieldset>
      {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
      <button disabled={pending} className="h-11 rounded-lg bg-frost px-5 font-medium text-ink disabled:opacity-50">{text.save}</button>
    </form>
  );
}
