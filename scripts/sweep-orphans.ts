import "./env";
import { crossTenantAccess, crossTenantDb } from "../lib/engine/db";
import { sweepOrphanDocuments } from "../lib/engine/archive";
import { reconcileStorage, recordUsage } from "../lib/engine/health";
import { MeteredStore, storeFromEnv } from "../lib/engine/store";

async function main() {
  const pool = crossTenantDb(crossTenantAccess.maintenance);
  const store = new MeteredStore(storeFromEnv());
  const out = await sweepOrphanDocuments(pool, store);
  console.log(`checked ${out.checked} objects, deleted ${out.deleted.length}`);
  for (const k of out.deleted) console.log(`  ${k}`);
  const size = await reconcileStorage(pool, store);
  await recordUsage(pool, { ...store.ops, bytes: 0, objects: 0 });
  console.log(`store: ${size.objects} objects, ${size.bytes} bytes`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
