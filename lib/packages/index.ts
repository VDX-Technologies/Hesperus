// Installed module packages. The engine knows none of them; routes and jobs look them up here.
import type { ModulePackage } from "../engine/package";
import { stomaPackage } from "./stoma";
import { recordsPackage } from "./records";

const packages: ModulePackage[] = [stomaPackage, recordsPackage];

export const getPackage = (id: string) => packages.find((p) => p.id === id);
export const packageIds = () => packages.map((p) => p.id);
