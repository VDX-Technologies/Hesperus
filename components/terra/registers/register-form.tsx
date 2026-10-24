"use client";
// Entry form of any register, built for a phone in the field: pick the object and the fields
// the type takes from it fill in, the date starts at today, "Repeat last" copies the previous
// entry of this user.
import { useState } from "react";
import { EventForm, type EventFormLabels, type EventFormValues } from "@/components/event-form";
import type { Schema } from "@/lib/engine/schema";
import { recordEntry } from "@/app/terra/o/[slug]/registers/actions";

export type ObjectOption = { id: string; label: string; values: Record<string, string> };
/** Objects of one `also` type the entry can be linked to besides its subject. */
export type AlsoOption = { type: string; label: string; objects: { id: string; label: string }[] };

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function RegisterForm({
  slug, type, schema, objects, also = [], last, initial, editId, suggestions, fieldLabels, optionLabels, labels, text,
}: {
  slug: string;
  type: string;
  schema: Schema;
  objects: ObjectOption[];
  also?: AlsoOption[];
  /** Values of the user's last entry, for "Repeat last". */
  last: EventFormValues | null;
  /** Values of the entry being corrected. */
  initial?: EventFormValues;
  editId?: number;
  suggestions: Record<string, string[]>;
  fieldLabels: Record<string, string>;
  optionLabels: Record<string, Record<string, string>>;
  labels: EventFormLabels;
  text: { object: string; repeatLast: string; comma: string };
}) {
  const [values, setValues] = useState<EventFormValues>(initial ?? { _ts: today() });
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const pick = (id: string) => setValues((s) => ({ ...s, _object: id, ...(objects.find((o) => o.id === id)?.values ?? {}) }));

  return (
    <div className="space-y-4">
      {last && !editId && (
        <button type="button" onClick={() => setValues({ ...last, _ts: today() })} className="h-11 w-full rounded-lg border border-line px-4 text-sm hover:bg-steel/40 sm:w-auto">
          ↻ {text.repeatLast}
        </button>
      )}
      <EventForm
        schema={schema}
        action={recordEntry}
        values={values}
        onChange={set}
        fieldLabels={fieldLabels}
        optionLabels={optionLabels}
        suggestions={suggestions}
        labels={labels}
        hidden={{ slug, type, ...(editId ? { supersedes: String(editId) } : {}) }}
        before={
          <label className="block text-sm">
            <span className="text-dim">{text.object} *</span>
            <select name="_object" value={values._object ?? ""} onChange={(e) => pick(e.target.value)} required className="mt-1 w-full">
              <option value="">{labels.choose}</option>
              {objects.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-dim">{text.comma}</span>
            {also.map((a) => {
              const own = new Set(a.objects.map((o) => o.id));
              const chosen = (values._also ?? "").split(",").filter(Boolean);
              return (
                <span key={a.type} className="mt-3 block">
                  <span className="text-dim">{a.label}</span>
                  <select
                    name="_also"
                    multiple
                    value={chosen.filter((id) => own.has(id))}
                    onChange={(e) => set("_also", [...chosen.filter((id) => !own.has(id)), ...[...e.target.selectedOptions].map((o) => o.value)].join(","))}
                    className="mt-1 w-full"
                    size={Math.min(5, Math.max(2, a.objects.length))}
                  >
                    {a.objects.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </span>
              );
            })}
          </label>
        }
      />
    </div>
  );
}
