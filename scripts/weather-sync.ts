/** Polls official MeteoAlarm warnings via MeteoGate and delivers the durable alert outbox. */
import "./env";
import { crossTenantAccess, crossTenantDb } from "../lib/engine/db";
import { getSettings } from "../lib/engine/settings";
import { mailerFromEnv } from "../lib/engine/mail";
import { sendWeatherOutbox, syncWeatherWarnings } from "../lib/engine/weather";

async function main() {
  const pool = crossTenantDb(crossTenantAccess.maintenance);
  try {
    if (!process.env.METEOGATE_API_KEY) console.warn("METEOGATE_API_KEY is not set: using public anonymous rate limits");
    const result = await syncWeatherWarnings(pool);
    const settings = await getSettings(crossTenantDb(crossTenantAccess.settings), true);
    const mailer = mailerFromEnv();
    if (!mailer) console.warn("RESEND_API_KEY is not set: weather email alerts stay queued");
    const delivery = await sendWeatherOutbox(pool, mailer, String(settings["alerts.email_from"] ?? ""));
    console.log(JSON.stringify({ ...result, notifications: delivery }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
