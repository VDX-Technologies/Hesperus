"use client";

/** Crop presets: fill the inputs of the surrounding settings form, the user then saves. */
export function PresetPicker({
  presets,
  defaults,
  label,
  help,
  resetLabel,
}: {
  presets: { id: string; name: string; values: Record<string, string> }[];
  defaults: Record<string, string>;
  label: string;
  help: string;
  resetLabel: string;
}) {
  const fill = (el: HTMLElement, values: Record<string, string>) => {
    const form = el.closest("form");
    if (!form) return;
    for (const [k, v] of Object.entries(values)) {
      const input = form.elements.namedItem(k);
      if (input instanceof HTMLInputElement) {
        input.value = v;
        input.classList.add("ring-1", "ring-ice");
        setTimeout(() => input.classList.remove("ring-1", "ring-ice"), 1200);
      }
    }
  };
  return (
    <div className="rounded-lg border border-line-soft bg-ink-950/40 p-4">
      <div className="text-sm font-medium">{label}</div>
      <p className="mt-0.5 text-xs text-dim">{help}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {presets.map((p) => (
          <button key={p.id} type="button" onClick={(e) => fill(e.currentTarget, p.values)} className="btn px-3 py-1.5 text-xs">
            {p.name}
          </button>
        ))}
        <button type="button" onClick={(e) => fill(e.currentTarget, defaults)} className="px-3 py-1.5 text-xs text-dim hover:text-mist">
          {resetLabel}
        </button>
      </div>
    </div>
  );
}
