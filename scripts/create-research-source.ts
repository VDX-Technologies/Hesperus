/**
 * Creates the push source a research pipeline sends with: module "custom", bound to one project,
 * so its token writes that project's results (and datasets) and nothing else. Prints the token
 * once; it is not stored in clear.
 *   npx tsx scripts/create-research-source.ts <org-slug> <project external id or id> [source name]
 */
import "./env";
import { crossTenantAccess, crossTenantDb, forTenant } from "../lib/engine/db";
import { getObject, objectByExternalId } from "../lib/engine/custom-objects";
import { createSource } from "../lib/engine/sources";
import { record } from "../lib/engine/audit";

const [slug, project, name] = process.argv.slice(2);
if (!slug || !project) {
  console.error("usage: create-research-source.ts <org-slug> <project external id or id> [source name]");
  process.exit(1);
}

async function main() {
  const pool = crossTenantDb(crossTenantAccess.maintenance);
  const { rows } = await pool.query<{ id: string }>(`select id from organizations where slug = $1`, [slug]);
  if (!rows[0]) throw new Error(`no organization "${slug}"`);
  const db = forTenant(pool, rows[0].id);
  const p = /^[0-9a-f-]{36}$/i.test(project) ? await getObject(db, project) : await objectByExternalId(db, "custom.project", project);
  if (!p || p.type !== "custom.project") throw new Error(`no project "${project}" in "${slug}"`);
  const { source, token } = await createSource(pool, {
    tenantId: rows[0].id, name: name ?? `${p.name} pipeline`, module: "custom",
    config: { scope: { link: "project", id: p.id, also: ["custom.dataset"] } },
  });
  await record(db, null, "source.create", { objectId: p.id, subject: source.name, data: { source: source.id, connector: "push", module: "custom", scope: p.id } });
  console.log(`source ${source.id} for "${p.name}"\nVDX_TOKEN=${token}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
