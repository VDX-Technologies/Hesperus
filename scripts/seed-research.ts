import "./env";
import { crossTenantAccess, crossTenantDb, forTenant } from "../lib/engine/db";
import { seedResearch } from "./research/types";

const [slug] = process.argv.slice(2);
if (!slug) {
  console.error("usage: seed-research.ts <org-slug>");
  process.exit(1);
}

async function main() {
  const pool = crossTenantDb(crossTenantAccess.maintenance);
  const { rows } = await pool.query<{ id: string; owner: string | null; email: string | null }>(
    `select o.id, m.user_id owner, u.email from organizations o
       left join memberships m on m.org_id = o.id and m.role = 'owner'
       left join auth.users u on u.id = m.user_id
      where o.slug = $1 order by m.user_id limit 1`,
    [slug],
  );
  if (!rows[0]) throw new Error(`no organization "${slug}"`);
  if (!rows[0].owner) throw new Error(`"${slug}" has no owner to author the types`);
  const saved = await seedResearch(forTenant(pool, rows[0].id), { id: rows[0].owner, email: rows[0].email, role: "owner" });
  console.log(saved.join("\n"));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
