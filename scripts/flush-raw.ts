/**
 * Moves closed hours from raw_inbox to the R2 archive. Run hourly (GitHub Actions).
 *   npx tsx scripts/flush-raw.ts
 */
import "./env";
import { getPool } from "../lib/engine/db";
import { flushRawInbox } from "../lib/engine/archive";
import { storeFromEnv } from "../lib/engine/store";

async function main() {
  const pool = getPool();
  const out = await flushRawInbox(pool, storeFromEnv());
  console.log(`flushed ${out.rows} rows into ${out.objects.length} objects`);
  for (const k of out.objects) console.log(`  ${k}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
