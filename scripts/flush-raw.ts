/**
 * Moves closed hours from raw_inbox to the R2 archive. Run hourly (GitHub Actions).
 *   npx tsx scripts/flush-raw.ts
 */
import "./env";
import { crossTenantAccess, crossTenantDb } from "../lib/engine/db";
import { flushRawInbox } from "../lib/engine/archive";
import { recordUsage } from "../lib/engine/health";
import { MeteredStore, storeFromEnv } from "../lib/engine/store";

async function main() {
  const pool = crossTenantDb(crossTenantAccess.maintenance);
  const store = new MeteredStore(storeFromEnv());
  const out = await flushRawInbox(pool, store);
  await recordUsage(pool, store.ops);
  console.log(`flushed ${out.rows} rows into ${out.objects.length} objects`);
  for (const k of out.objects) console.log(`  ${k}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
