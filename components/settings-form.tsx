import type { ModuleDef, Locale } from "@/lib/modules/types";
import type { Dict } from "@/lib/i18n";

/**
 * Generic settings form for any module: fields grouped as the module defines them.
 * values = this level's own values; inherited = what applies when a field is left empty.
 */
export function SettingsForm({
  mod,
  action,
  hidden,
  values,
  inherited,
  editable,
  allowEmpty,
  t,
  locale,
  extraButton,
}: {
  mod: ModuleDef;
  action: (formData: FormData) => Promise<void>;
  hidden: Record<string, string>;
  values: Record<string, number>;
  inherited: Record<string, number>;
  editable: boolean;
  allowEmpty: boolean;
  t: Dict;
  locale: Locale;
  extraButton?: React.ReactNode;
}) {
  const groups = new Map<string, typeof mod.settings>();
  for (const s of mod.settings) groups.set(s.group[locale], [...(groups.get(s.group[locale]) ?? []), s]);
  const shown = (v: number | undefined, scale = 1) => (v === undefined ? "" : String(Math.round((v / scale) * 100) / 100));
  return (
    <form action={action} className="card p-5">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <fieldset disabled={!editable} className="grid gap-6 md:grid-cols-2">
        {[...groups.entries()].map(([group, items]) => (
          <div key={group}>
            <div className="mb-2 text-sm font-medium">{group}</div>
            <div className="flex flex-wrap gap-3">
              {items.map((s) => (
                <label key={s.key} className="flex w-40 flex-col gap-1 text-xs text-mist" title={s.help?.[locale]}>
                  <span>
                    {s.label[locale]}
                    {allowEmpty && values[s.key] !== undefined && <span className="ml-1 text-ice">· {t.custom}</span>}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <input
                      name={s.key}
                      type="number"
                      inputMode="decimal"
                      step={s.step}
                      min={s.min}
                      max={s.max}
                      required={!allowEmpty}
                      defaultValue={allowEmpty ? shown(values[s.key], s.scale) : shown(values[s.key] ?? inherited[s.key], s.scale)}
                      placeholder={shown(inherited[s.key], s.scale)}
                      className="num w-24 disabled:opacity-60"
                    />
                    <span className="text-dim">{s.unit}</span>
                  </span>
                  {s.help && <span className="text-[11px] leading-tight text-dim">{s.help[locale]}</span>}
                </label>
              ))}
            </div>
          </div>
        ))}
      </fieldset>
      {editable ? (
        <div className="mt-5 flex flex-wrap gap-3">
          <button className="rounded-lg bg-frost px-4 py-2 text-sm font-medium text-ink-950 hover:bg-white">{t.save}</button>
          {extraButton}
        </div>
      ) : (
        <p className="mt-4 text-xs text-dim">{t.readOnly}</p>
      )}
    </form>
  );
}
