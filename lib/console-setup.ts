// What turning a console on prepares in the organization, through the same APIs as the schema editor.
import type { TenantDb } from "./engine/db";
import type { Author } from "./engine/manual";
import { getObjectType } from "./engine/custom-objects";
import { RESEARCH } from "./research";
import { seedResearch } from "../scripts/research/types";

/** Loads the console's types when the organization has none yet; types it already has (maybe
 * edited by the customer) are left as they are. Returns the types it saved. */
export async function prepareConsole(db: TenantDb, author: Author, id: string): Promise<string[]> {
  if (id === "research" && !(await getObjectType(db, RESEARCH.project))) return seedResearch(db, author);
  return [];
}
