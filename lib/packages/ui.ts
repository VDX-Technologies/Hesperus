import { lora } from "./lora/model";
import { records } from "./records/model";
import { agronomy } from "./agronomy/model";
import type { PackageDef } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PACKAGES: Record<string, PackageDef<any>> = { [lora.id]: lora, [records.id]: records, [agronomy.id]: agronomy };

export const UPCOMING = [
  { id: "tag", name: "Tag", tagline: { en: "Windows, irrigation and pumps, verified", it: "Finestre, irrigazione e pompe, verificate" } },
  { id: "kestrel", name: "Kestrel", tagline: { en: "Aerial survey drone", it: "Drone per rilievi aerei" } },
  { id: "assistant", name: "Assistant", tagline: { en: "AI insights on your data", it: "Analisi AI dei tuoi dati" } },
];

export const getPackageDef = (id: string) => PACKAGES[id] ?? null;
