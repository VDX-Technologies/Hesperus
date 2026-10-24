"use client";
// A checkbox that selects or clears every checkbox named `name` in its form.

export function CheckAll({ name, label }: { name: string; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      title={label}
      onChange={(e) => {
        const form = e.currentTarget.form;
        if (!form) return;
        for (const el of form.querySelectorAll<HTMLInputElement>(`input[type=checkbox][name="${name}"]`)) el.checked = e.currentTarget.checked;
      }}
    />
  );
}
