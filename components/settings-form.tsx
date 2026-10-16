import type { ModuleDef, Locale } from "@/lib/modules/types";
import type { Dict } from "@/lib/i18n";
import { PresetPicker } from "@/components/preset-picker";

/**
 * Generic settings form for any module: one card per group, as the module defines them.
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
  const defaults = mod.defaultConfig as Record<string, number>;
  const scaled = (cfg: Record<string, unknown>) =>
    Object.fromEntries(mod.settings.filter((s) => typeof cfg[s.key] === "number").map((s) => [s.key, shown(cfg[s.key] as number, s.scale)]));
  return (
    <form action={action} className="card p-4 sm:p-5">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {editable && mod.presets?.length ? (
        <div className="mb-4">
          <PresetPicker
            presets={mod.presets.map((p) => ({ id: p.id, name: p.name[locale], values: scaled(p.config as Record<string, unknown>) }))}
            defaults={allowEmpty ? Object.fromEntries(mod.settings.map((s) => [s.key, ""])) : scaled(defaults)}
            label={t.presets}
            help={t.presetsHelp}
            resetLabel={t.resetDefaults}
          />
        </div>
      ) : null}
      <fieldset disabled={!editable} className="grid gap-4 lg:grid-cols-2">
        {[...groups.entries()].map(([group, items]) => (
          <div key={group} className="rounded-lg border border-line-soft p-4">
            <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-dim">{group}</div>
            <div className="grid gap-4 sm:grid-cols-2">
              {items.map((s) => {
                const current = values[s.key] ?? inherited[s.key];
                const changed = current !== undefined && defaults[s.key] !== undefined && current !== defaults[s.key];
                return (
                  <label key={s.key} className="flex flex-col gap-1.5 text-xs text-mist">
                    <span className="flex flex-wrap items-center gap-x-1.5">
                      {s.label[locale]}
                      {allowEmpty && values[s.key] !== undefined && <span className="text-ice">· {t.custom}</span>}
                      {!allowEmpty && changed && <span className="h-1.5 w-1.5 rounded-full bg-ice" title={t.modified} />}
                    </span>
                    <span className="relative flex items-center">
                      <input
                        name={s.key}
                        type="number"
                        inputMode="decimal"
                        step={s.step}
                        min={s.min}
                        max={s.max}
                        required={!allowEmpty}
                        defaultValue={allowEmpty ? shown(values[s.key], s.scale) : shown(current, s.scale)}
                        placeholder={shown(inherited[s.key], s.scale)}
                        className="num w-full pr-14 transition-shadow disabled:opacity-60"
                      />
                      <span className="pointer-events-none absolute right-3 text-dim">{s.unit}</span>
                    </span>
                    <span className="text-[11px] leading-snug text-dim">
                      {s.help?.[locale]}
                      {changed && (
                        <span className="num">
                          {s.help ? " · " : ""}
                          {t.defaultVal} {shown(defaults[s.key], s.scale)} {s.unit}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
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
