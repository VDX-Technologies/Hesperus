import "server-only";
import type { SettingDef } from "@/lib/packages/types";

/**
 * Reads module settings from a form. Values are shown in display units and stored in the
 * module's units (SettingDef.scale). Empty fields are left out: for a device that means
 * "inherit the company value". Out-of-range numbers are clamped.
 */
export function parseSettings(settings: SettingDef[], formData: FormData) {
  const out: Record<string, number> = {};
  for (const s of settings) {
    const raw = formData.get(s.key);
    if (raw === null || String(raw).trim() === "") continue;
    let v = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(v)) continue;
    if (s.min !== undefined) v = Math.max(s.min, v);
    if (s.max !== undefined) v = Math.min(s.max, v);
    out[s.key] = v * (s.scale ?? 1);
  }
  return out;
}
