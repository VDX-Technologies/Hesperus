import type { TenantDb } from "./engine/db";
import type { Author } from "./engine/manual";
import { getObjectType } from "./engine/custom-objects";
import { RESEARCH } from "./research";
import { seedResearch } from "../scripts/research/types";

export async function prepareConsole(db: TenantDb, author: Author, id: string): Promise<string[]> {
  if (id === "research" && !(await getObjectType(db, RESEARCH.project))) return seedResearch(db, author);
  return [];
}
