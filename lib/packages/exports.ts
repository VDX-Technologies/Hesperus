import "server-only";
import type { TenantDb } from "../engine/db";
import type { EventTypeInfo, Locale, RegisterFilters } from "../engine/registers";
import type { Text } from "./types";
import { agronomyExports } from "./agronomy/exports";

export interface ExportContext {
  db: TenantDb;
  type: EventTypeInfo;
  filters: RegisterFilters;
  organization: string;
  name: string;
  locale: Locale;
}

export interface RegisterExport {
  type: string;
  id: string;
  label: Text;
  run(ctx: ExportContext): Promise<Response>;
}

const all: RegisterExport[] = [...agronomyExports];

export const exportsOf = (type: string) => all.filter((x) => x.type === type);
