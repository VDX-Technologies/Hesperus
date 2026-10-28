import "./env";
import { crossTenantAccess, crossTenantDb } from "../lib/engine/db";
import { replaySource } from "../lib/engine/replay";
import { recordUsage } from "../lib/engine/health";
import { MeteredStore, storeFromEnv } from "../lib/engine/store";
import type { Source } from "../lib/engine/sources";
import { getPackage } from "../lib/packages";

const args = process.argv.slice(2);
const sourceId = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--from");
const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : undefined;
if (!sourceId) {
  console.error("usage: replay.ts <source-id> [--from yyyy/mm/dd] [--events] [--dry-run]");
  process.exit(1);
}

async function main() {
  const pool = crossTenantDb(crossTenantAccess.maintenance);
  const { rows } = await pool.query<Source>(
    `select id, tenant_id, name, connector, module, config, status from sources where id = $1`, [sourceId],
  );
  if (!rows[0]) throw new Error(`no source ${sourceId}`);
  const pkg = getPackage(rows[0].module);
  if (!pkg) throw new Error(`module "${rows[0].module}" is not installed`);

  const store = new MeteredStore(storeFromEnv());
  const { objects, total } = await replaySource(pool, store, rows[0], pkg, {
    from, events: args.includes("--events"), dryRun: args.includes("--dry-run"),
  });
  await recordUsage(pool, store.ops);
  console.log(`${objects} archive objects, ${total.accepted} messages, ${total.metrics} new metrics, ${total.events} events`);
  for (const r of total.rejected.slice(0, 20)) console.log(`  rejected: ${r.error}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
