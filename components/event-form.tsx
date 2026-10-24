"use client";
// Generic form for a typed event: one input per schema field, built from the event type's
// schema (quantity = number plus unit, enum = select, timestamp = date, object = JSON). Values are plain text
// (comma decimals allowed); the server action turns them into a payload with payloadFromForm
// and validates it. Controlled from outside when a page fills fields (repeat last, defaults).
import { useActionState, useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import type { Schema } from "@/lib/engine/schema";

export type EventFormState = { ok?: number; error?: string; fieldErrors?: Record<string, string> } | null;
export type EventFormValues = Record<string, string>;

export type EventFormLabels = {
  submit: string;
  pending: string;
  saved: string;
  choose: string;
  /** Text for error codes (notNumber, unitRequired, ...) and server errors. */
  errors: Record<string, string>;
};

export function EventForm({
  schema,
  action,
  fieldLabels,
  labels: l,
  order,
  values: controlled,
  onChange,
  initial = {},
  suggestions = {},
  optionLabels = {},
  hidden = {},
  before,
}: {
  schema: Schema;
  action: (prev: EventFormState, form: FormData) => Promise<EventFormState>;
  fieldLabels: Record<string, string>;
  labels: EventFormLabels;
  /** Field order; fields left out are not shown. Defaults to the schema order. */
  order?: string[];
  values?: EventFormValues;
  onChange?: (name: string, value: string) => void;
  initial?: EventFormValues;
  /** Autocomplete for free-text fields. */
  suggestions?: Record<string, string[]>;
  /** Text for enum values, per field. */
  optionLabels?: Record<string, Record<string, string>>;
  hidden?: Record<string, string>;
  /** Extra inputs above the fields (e.g. the objects the event is about). */
  before?: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);
  const [own, setOwn] = useState<EventFormValues>(initial);
  const values = controlled ?? own;
  const set = (name: string, value: string) => (onChange ? onChange(name, value) : setOwn((v) => ({ ...v, [name]: value })));
  const err = (k: string) => state?.fieldErrors?.[k];

  return (
    <form action={formAction} className="space-y-4">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {before}
      <div className="grid gap-4 sm:grid-cols-2">
        {(order ?? Object.keys(schema)).map((k) => {
          const spec = schema[k];
          if (!spec) return null;
          const label = (
            <span className="text-dim">
              {fieldLabels[k] ?? k}
              {spec.required ? " *" : ""}
            </span>
          );
          const common = { name: k, value: values[k] ?? "", onChange: (e: { target: { value: string } }) => set(k, e.target.value), "aria-invalid": !!err(k) };
          let input: React.ReactNode;
          if (spec.enum) {
            input = (
              <select {...common} required={spec.required} className="mt-1 w-full">
                <option value="">{l.choose}</option>
                {spec.enum.map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {optionLabels[k]?.[String(o)] ?? String(o)}
                  </option>
                ))}
              </select>
            );
          } else if (spec.type === "quantity") {
            const units = spec.units ?? [];
            input = (
              <div className="mt-1 flex gap-2">
                <input {...common} inputMode="decimal" required={spec.required} className="min-w-0 flex-1" />
                <select name={`${k}.unit`} value={values[`${k}.unit`] ?? (units.length === 1 ? units[0] : "")} onChange={(e) => set(`${k}.unit`, e.target.value)} required className="w-20">
                  {units.length !== 1 && <option value="">–</option>}
                  {units.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
            );
          } else if (spec.type === "number" || spec.type === "integer") {
            input = <input {...common} inputMode={spec.type === "number" ? "decimal" : "numeric"} required={spec.required} className="mt-1 w-full" />;
          } else if (spec.type === "timestamp") {
            input = <input {...common} type="date" required={spec.required} className="mt-1 w-full" />;
          } else if (spec.type === "object") {
            input = <textarea {...common} rows={3} spellCheck={false} required={spec.required} placeholder="{ }" className="mt-1 w-full font-mono text-xs" />;
          } else if (spec.format === "text") {
            input = <textarea {...common} rows={3} required={spec.required} className="mt-1 w-full" />;
          } else if (spec.type === "boolean") {
            input = <input type="checkbox" name={k} checked={values[k] === "true"} onChange={(e) => set(k, String(e.target.checked))} className="mt-2 block" />;
          } else {
            const list = suggestions[k];
            input = (
              <>
                <input {...common} list={list ? `ef-${k}` : undefined} autoComplete="off" required={spec.required} className="mt-1 w-full" />
                {list && (
                  <datalist id={`ef-${k}`}>
                    {list.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                )}
              </>
            );
          }
          return (
            <label key={k} className="block text-sm">
              {label}
              {input}
              {err(k) && <span className="mt-1 block text-xs text-alarm">{l.errors[err(k)!] ?? err(k)}</span>}
            </label>
          );
        })}
      </div>
      <SubmitButton pending={l.pending} className="h-11 w-full rounded-lg bg-frost px-4 text-sm font-medium text-ink-950 transition-colors hover:bg-white sm:w-auto">
        {l.submit}
      </SubmitButton>
      {state?.error && <p className="text-sm text-alarm">{l.errors[state.error] ?? state.error}</p>}
      {state?.ok && <p className="text-sm text-ok">{l.saved}</p>}
    </form>
  );
}
