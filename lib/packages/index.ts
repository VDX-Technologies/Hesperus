// Installed module packages. The engine knows none of them; routes and jobs look them up here.
import type { ModulePackage } from "../engine/package";

const packages: ModulePackage[] = [];

export const getPackage = (id: string) => packages.find((p) => p.id === id);
