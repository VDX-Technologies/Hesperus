/**
 * UI side of the module registry: which widgets each product adds to the overview and which
 * component renders its device page. Pair of lib/modules/index.ts.
 */
import { StomaOverview } from "./stoma/overview";
import { StomaDevice } from "./stoma/device";

export const MODULE_UI = {
  stoma: { Overview: StomaOverview, Device: StomaDevice },
} as const;

export type ModuleUiId = keyof typeof MODULE_UI;
export const hasUi = (id: string): id is ModuleUiId => id in MODULE_UI;
