import { ValidationError, type ModulePackage, type PropertySpec } from "../../engine/package";
import { agronomy } from "./model";

export { agronomy };

export const PHASES = ["semina", "trapianto", "crescita", "fioritura", "raccolta"] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_LABELS: Record<Phase, Record<"en" | "it", string>> = {
  semina: { en: "Sowing", it: "Semina" },
  trapianto: { en: "Transplant", it: "Trapianto" },
  crescita: { en: "Growth", it: "Crescita" },
  fioritura: { en: "Flowering", it: "Fioritura" },
  raccolta: { en: "Harvest", it: "Raccolta" },
};

const phase: PropertySpec = { type: "string", enum: [...PHASES], options: PHASE_LABELS, label: { en: "Phase", it: "Fase" } };
const hectares = (label: Record<string, string>): PropertySpec => ({ type: "number", min: 0, max: 100000, label });
const notes: PropertySpec = { type: "string", label: { en: "Notes", it: "Note" } };
const operator: PropertySpec = { type: "string", label: { en: "Operator", it: "Operatore" } };

export const CROP_PROPERTIES: Record<string, PropertySpec> = {
  species: { type: "string", required: true, label: { en: "Species", it: "Specie" } },
  variety: { type: "string", label: { en: "Variety", it: "Varietà" } },
  hectares: { ...hectares({ en: "Area (ha)", it: "Superficie (ha)" }), required: true },
  phase: { ...phase, required: true },
  start: { type: "timestamp", label: { en: "Start", it: "Inizio" } },
  end: { type: "timestamp", label: { en: "End", it: "Fine" } },
  status: { type: "string", enum: ["active", "archived"], label: { en: "Status", it: "Stato" } },
};

export const CROP_FORM = Object.fromEntries(Object.entries(CROP_PROPERTIES).filter(([k]) => k !== "status")) as Record<string, PropertySpec>;

export const TREATMENT_FIELDS: Record<string, PropertySpec> = {
  area_ha: { ...hectares({ en: "Treated area (ha)", it: "Superficie trattata (ha)" }), required: true },
  phase: { ...phase, required: true },
  adversity: { type: "string", required: true, label: { en: "Pest / disease", it: "Avversità" } },
  product: { type: "string", required: true, label: { en: "Product", it: "Prodotto" } },
  quantity: { type: "quantity", required: true, units: ["kg", "L"], min: 0, label: { en: "Quantity", it: "Quantità" } },
  operator,
  notes,
};

export const agronomyPackage: ModulePackage = {
  id: "agronomy",
  objectTypes: [{ key: "crop", name: { en: "Crop", it: "Coltura" }, properties: CROP_PROPERTIES }],
  eventTypes: [
    { key: "treatment", name: { en: "Treatment", it: "Trattamento" }, fields: TREATMENT_FIELDS, subject: "agronomy.crop", fromSubject: { area_ha: "hectares", phase: "phase" } },
    {
      key: "sowing",
      name: { en: "Sowing", it: "Semina" },
      fields: { area_ha: hectares({ en: "Area (ha)", it: "Superficie (ha)" }), variety: { type: "string", label: { en: "Variety", it: "Varietà" } }, operator, notes },
      subject: "agronomy.crop",
      fromSubject: { area_ha: "hectares", variety: "variety" },
    },
    { key: "transplant", name: { en: "Transplant", it: "Trapianto" }, fields: { area_ha: hectares({ en: "Area (ha)", it: "Superficie (ha)" }), operator, notes }, subject: "agronomy.crop", fromSubject: { area_ha: "hectares" } },
    {
      key: "harvest",
      name: { en: "Harvest", it: "Raccolta" },
      fields: { area_ha: hectares({ en: "Area (ha)", it: "Superficie (ha)" }), yield: { type: "quantity", units: ["kg", "t"], min: 0, label: { en: "Yield", it: "Resa" } }, operator, notes },
      subject: "agronomy.crop",
      fromSubject: { area_ha: "hectares" },
    },
  ],
  metrics: [],
  normalize() {
    throw new ValidationError("agronomy data is entered by hand");
  },
};
