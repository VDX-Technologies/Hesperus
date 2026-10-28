import { LoraOverview } from "./lora/overview";
import { LoraDevice } from "./lora/device";
import { RecordsOverview } from "./records/overview";
import { RecordsDevice } from "./records/device";
import { AgronomyOverview } from "./agronomy/overview";
import { AgronomyDevice } from "./agronomy/device";

export const MODULE_UI = {
  lora: { Overview: LoraOverview, Device: LoraDevice },
  records: { Overview: RecordsOverview, Device: RecordsDevice },
  agronomy: { Overview: AgronomyOverview, Device: AgronomyDevice },
} as const;

export type ModuleUiId = keyof typeof MODULE_UI;
export const hasUi = (id: string): id is ModuleUiId => id in MODULE_UI;
