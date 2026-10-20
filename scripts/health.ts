/**
 * Health and quota check; mails the admins about problems. Run hourly (GitHub Actions).
 *   npx tsx scripts/health.ts
 */
import "./env";
import { crossTenantAccess, crossTenantDb } from "../lib/engine/db";
import { recordUsage, runHealth } from "../lib/engine/health";
import { mailerFromEnv } from "../lib/engine/mail";
import { MeteredStore, storeFromEnv } from "../lib/engine/store";

async function main() {
  const pool = crossTenantDb(crossTenantAccess.maintenance);
  const store = new MeteredStore(storeFromEnv());
  const mailer = mailerFromEnv();
  if (!mailer) console.warn("RESEND_API_KEY is not set: problems are recorded but not mailed");
  const { report, mail, mailed } = await runHealth(pool, { store, mailer });
  await recordUsage(pool, store.ops);
  for (const c of report.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.message}`);
  if (mail) console.log(`\n${mail.subject}${mailed ? ` -> ${mailed} recipients` : " (not mailed)"}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
