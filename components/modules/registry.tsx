/**
 * UI side of the module registry: which widgets each product adds to the overview and which
 * component renders its object page. Pair of lib/packages/ui.ts.
 */
import { StomaOverview } from "./stoma/overview";
import { StomaDevice } from "./stoma/device";
import { RecordsOverview } from "./records/overview";
import { RecordsDevice } from "./records/device";
import { AgronomyOverview } from "./agronomy/overview";
import { AgronomyDevice } from "./agronomy/device";

export const MODULE_UI = {
  stoma: { Overview: StomaOverview, Device: StomaDevice },
  records: { Overview: RecordsOverview, Device: RecordsDevice },
  agronomy: { Overview: AgronomyOverview, Device: AgronomyDevice },
} as const;

export type ModuleUiId = keyof typeof MODULE_UI;
export const hasUi = (id: string): id is ModuleUiId => id in MODULE_UI;
