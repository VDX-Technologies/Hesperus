"use client";
// Entry form of any register, built for a phone in the field: pick the object and the fields
// the type takes from it fill in, the date starts at today, "Repeat last" copies the previous
// entry of this user.
import { useState } from "react";
import { EventForm, type EventFormLabels, type EventFormValues } from "@/components/event-form";
import type { Schema } from "@/lib/engine/schema";
import { recordEntry } from "@/app/o/[slug]/registers/actions";

export type ObjectOption = { id: string; label: string; values: Record<string, string> };

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function RegisterForm({
  slug, type, schema, objects, last, initial, editId, suggestions, fieldLabels, optionLabels, labels, text,
}: {
  slug: string;
  type: string;
  schema: Schema;
  objects: ObjectOption[];
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
          </label>
        }
      />
    </div>
  );
}
