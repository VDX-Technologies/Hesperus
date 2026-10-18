// Extra exports a package adds to the register of one of its event types (the generic PDF and
// CSV come with every register). Looked up by event type; the engine knows none of them.
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
  /** File name without extension. */
  name: string;
  locale: Locale;
}

export interface RegisterExport {
  /** Event type, "agronomy.treatment". */
  type: string;
  /** Value of `format` in the export URL; must not be "pdf" or "csv". */
  id: string;
  label: Text;
  run(ctx: ExportContext): Promise<Response>;
}

const all: RegisterExport[] = [...agronomyExports];

export const exportsOf = (type: string) => all.filter((x) => x.type === type);
