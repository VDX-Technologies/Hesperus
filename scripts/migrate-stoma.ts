/**
 * Moves organizations' Stoma data from the legacy tables into the engine (idempotent).
 *   npx tsx scripts/migrate-stoma.ts [<org-id> ...] [--dry-run]
 * Without org ids it migrates every organization with the Stoma module enabled.
 */
import "./env";
import { getPool, tx } from "../lib/engine/db";
import { migrateOrg, planOrg } from "../lib/packages/stoma/migrate";

const LIMIT_MB = 500;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
async function main() {
  const pool = getPool();
  let orgs = args.filter((a) => !a.startsWith("--"));
  if (!orgs.length) orgs = (await pool.query(`select org_id from org_modules where module = 'stoma'`)).rows.map((r) => r.org_id);
  
  // Bytes per metric row: measured when the table has data, else a conservative estimate.
  const { rows: [s] } = await pool.query(
    `select pg_database_size(current_database())::float8 as db,
            coalesce(pg_total_relation_size('metrics_default')::float8 / nullif((select count(*) from metrics_default), 0), 120) as row`,
  );
  let rows = 0;
  for (const org of orgs) {
    const p = await planOrg(pool, org);
    rows += p.metrics;
    if (dryRun) console.log(org, p);
    else console.log(org, await tx(pool, (c) => migrateOrg(c, org)));
  }
  const addMb = (rows * s.row) / 1e6;
  console.log(`database ${(s.db / 1e6).toFixed(1)} MB, metrics up to +${addMb.toFixed(1)} MB` +
    ` -> ${((s.db / 1e6) + (dryRun ? addMb : 0)).toFixed(1)} MB of ${LIMIT_MB} MB`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
