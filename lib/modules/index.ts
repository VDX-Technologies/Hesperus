/** Module registry: every VDX product the platform knows. Add new products here. */
import { stoma } from "./stoma";
import type { ModuleDef } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MODULES: Record<string, ModuleDef<any>> = {
  [stoma.id]: stoma,
};

/** Products on the roadmap: shown in the vendor console, not yet installable. */
export const UPCOMING = [
  { id: "tag", name: "Tag", tagline: { en: "Windows, irrigation and pumps, verified", it: "Finestre, irrigazione e pompe, verificate" } },
  { id: "kestrel", name: "Kestrel", tagline: { en: "Aerial survey drone", it: "Drone per rilievi aerei" } },
  { id: "assistant", name: "Assistant", tagline: { en: "AI insights on your data", it: "Analisi AI dei tuoi dati" } },
];

export function getModule(id: string) {
  return MODULES[id] ?? null;
}

export function alertMessage(code: string, params: Record<string, number | string>, locale: "en" | "it") {
  const [mod, ...rest] = code.split(".");
  return getModule(mod)?.alertText(rest.join("."), params, locale) ?? code;
}

export type { ModuleDef } from "./types";
