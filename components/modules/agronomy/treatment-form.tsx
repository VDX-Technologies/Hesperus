"use client";
// Treatment entry, built for a phone in the field: pick the crop and its area and phase fill
// in, the date starts at today, "Repeat last" copies the previous treatment of this user.
import { useState } from "react";
import { EventForm, type EventFormLabels, type EventFormValues } from "@/components/event-form";
import { TREATMENT_FORM, TREATMENT_ORDER } from "@/lib/packages/agronomy/form";
import { recordTreatment } from "@/app/o/[slug]/treatments/actions";

export type CropOption = { id: string; label: string; hectares: number | null; phase: string | null };

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function TreatmentForm({
  slug, crops, last, initial, editId, suggestions, fieldLabels, optionLabels, labels, text,
}: {
  slug: string;
  crops: CropOption[];
  /** Values of the user's last treatment, for "Repeat last". */
  last: EventFormValues | null;
  /** Values of the treatment being corrected. */
  initial?: EventFormValues;
  editId?: number;
  suggestions: Record<string, string[]>;
  fieldLabels: Record<string, string>;
  optionLabels: Record<string, Record<string, string>>;
  labels: EventFormLabels;
  text: { crop: string; repeatLast: string; comma: string };
}) {
  const [values, setValues] = useState<EventFormValues>(initial ?? { date: today() });
  const decimal = (n: number | null) => (n === null ? "" : String(n).replace(".", ","));
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
  const pickCrop = (id: string) => {
    const c = crops.find((x) => x.id === id);
    setValues((s) => ({ ...s, crop: id, ...(c ? { area_ha: decimal(c.hectares), phase: c.phase ?? "" } : {}) }));
  };

  return (
    <div className="space-y-4">
      {last && !editId && (
        <button type="button" onClick={() => setValues({ ...last, date: today() })} className="h-11 w-full rounded-lg border border-line px-4 text-sm hover:bg-steel/40 sm:w-auto">
          ↻ {text.repeatLast}
        </button>
      )}
      <EventForm
        schema={TREATMENT_FORM}
        action={recordTreatment}
        order={TREATMENT_ORDER}
        values={values}
        onChange={set}
        fieldLabels={fieldLabels}
        optionLabels={optionLabels}
        suggestions={suggestions}
        labels={labels}
        hidden={{ slug, ...(editId ? { supersedes: String(editId) } : {}) }}
        before={
          <label className="block text-sm">
            <span className="text-dim">{text.crop} *</span>
            <select name="crop" value={values.crop ?? ""} onChange={(e) => pickCrop(e.target.value)} required className="mt-1 w-full">
              <option value="">{labels.choose}</option>
              {crops.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-dim">{text.comma}</span>
          </label>
        }
      />
    </div>
  );
}
