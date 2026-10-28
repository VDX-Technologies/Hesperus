import type { ModulePackage } from "../engine/package";
import { loraPackage } from "./lora";
import { recordsPackage } from "./records";
import { agronomyPackage } from "./agronomy";

const packages: ModulePackage[] = [loraPackage, recordsPackage, agronomyPackage];

export const getPackage = (id: string) => packages.find((p) => p.id === id);
export const packageIds = () => packages.map((p) => p.id);
