"use client";
// Crop form: name and place above the crop's own properties (species, area, phase, dates).
// With `id` it edits an existing crop: name and place are fixed, the properties change.
import { EventForm, type EventFormLabels, type EventFormValues } from "@/components/event-form";
import { CROP_FORM } from "@/lib/packages/agronomy";
import { saveCrop } from "@/app/terra/o/[slug]/crops/actions";

export function CropForm({ slug, id, initial, places, fieldLabels, optionLabels, labels, text }: {
  slug: string;
  id?: string;
  initial?: EventFormValues;
  places: { id: string; label: string }[];
  fieldLabels: Record<string, string>;
  optionLabels: Record<string, Record<string, string>>;
  labels: EventFormLabels;
  text: { name: string; place: string; noPlace: string };
}) {
  return (
    <EventForm
      schema={CROP_FORM}
      action={saveCrop}
      initial={initial}
      fieldLabels={fieldLabels}
      optionLabels={optionLabels}
      labels={labels}
      hidden={{ slug, ...(id ? { id } : {}) }}
      before={
        !id && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-dim">{text.name} *</span>
              <input name="name" required className="mt-1 w-full" />
            </label>
            <label className="block text-sm">
              <span className="text-dim">{text.place}</span>
              <select name="place" className="mt-1 w-full" defaultValue="">
                <option value="">{text.noPlace}</option>
                {places.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
          </div>
        )
      }
    />
  );
}
