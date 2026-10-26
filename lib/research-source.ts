// The push source a research pipeline sends with: module "custom", bound to one project, so its
// token writes that project's results (and datasets) and nothing else. Used by the admin engine
// page and scripts/create-research-source.ts.
import { forTenant, type Db } from "./engine/db";
import { getObject, objectByExternalId, type CustomObject } from "./engine/custom-objects";
import { createSource, type Source } from "./engine/sources";
import { record, type Actor } from "./engine/audit";
import { RESEARCH } from "./research";

/** `project` is the project's id or its external id. */
export async function createResearchSource(
  pool: Db,
  tenantId: string,
  project: string,
  opts: { name?: string; actor?: Actor } = {},
): Promise<{ source: Source; token: string; project: CustomObject }> {
  const db = forTenant(pool, tenantId);
  const p = /^[0-9a-f-]{36}$/i.test(project) ? await getObject(db, project) : await objectByExternalId(db, RESEARCH.project, project);
  if (!p || p.type !== RESEARCH.project) throw new Error(`no project "${project}"`);
  const { source, token } = await createSource(pool, {
    tenantId, name: opts.name?.trim() || `${p.name} pipeline`, module: "custom",
    config: { scope: { link: "project", id: p.id, also: [RESEARCH.dataset] } },
  });
  await record(db, opts.actor ?? null, "source.create", { objectId: p.id, subject: source.name, data: { source: source.id, connector: "push", module: "custom", scope: p.id } });
  return { source, token, project: p };
}
