// Console side of Agronomy: no metrics, settings or rules; crops and their register only.
import type { PackageDef } from "../types";

export const agronomy: PackageDef<Record<string, never>> = {
  id: "agronomy",
  name: "Agronomy",
  tagline: { en: "Crops and treatments register", it: "Colture e registro dei trattamenti" },
  offlineAfterS: 365 * 24 * 3600,
  metrics: [],
  defaults: {},
  settings: [],
  rules: () => [],
  alertText: () => "",
};
