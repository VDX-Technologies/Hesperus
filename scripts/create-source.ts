import "./env";
import { crossTenantAccess, crossTenantDb } from "../lib/engine/db";
import { createSource } from "../lib/engine/sources";

const [slug, module, ...name] = process.argv.slice(2);
if (!slug || !module || !name.length) {
  console.error("usage: create-source.ts <org-slug> <module> <name>");
  process.exit(1);
}

async function main() {
  const pool = crossTenantDb(crossTenantAccess.maintenance);
  const { rows } = await pool.query<{ id: string }>(`select id from organizations where slug = $1`, [slug]);
  if (!rows[0]) throw new Error(`no organization "${slug}"`);
  const { source, token } = await createSource(pool, { tenantId: rows[0].id, module, name: name.join(" ") });
  console.log(`source ${source.id}\ntoken  ${token}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
