"use client";
// New crop: name and place above the crop's own properties (species, area, phase, dates).
import { EventForm, type EventFormLabels } from "@/components/event-form";
import { CROP_PROPERTIES } from "@/lib/packages/agronomy";
import { createCrop } from "@/app/o/[slug]/treatments/actions";

export function CropForm({ slug, places, fieldLabels, optionLabels, labels, text }: {
  slug: string;
  places: { id: string; label: string }[];
  fieldLabels: Record<string, string>;
  optionLabels: Record<string, Record<string, string>>;
  labels: EventFormLabels;
  text: { name: string; place: string; noPlace: string };
}) {
  return (
    <EventForm
      schema={CROP_PROPERTIES}
      action={createCrop}
      fieldLabels={fieldLabels}
      optionLabels={optionLabels}
      labels={labels}
      hidden={{ slug }}
      before={
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
      }
    />
  );
}
