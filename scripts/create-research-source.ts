import "./env";
import { crossTenantAccess, crossTenantDb } from "../lib/engine/db";
import { createResearchSource } from "../lib/research-source";

const [slug, project, name] = process.argv.slice(2);
if (!slug || !project) {
  console.error("usage: create-research-source.ts <org-slug> <project external id or id> [source name]");
  process.exit(1);
}

async function main() {
  const pool = crossTenantDb(crossTenantAccess.maintenance);
  const { rows } = await pool.query<{ id: string }>(`select id from organizations where slug = $1`, [slug]);
  if (!rows[0]) throw new Error(`no organization "${slug}"`);
  const { source, token, project: p } = await createResearchSource(pool, rows[0].id, project, { name });
  console.log(`source ${source.id} for "${p.name}"\nVDX_TOKEN=${token}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
