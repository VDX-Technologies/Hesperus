/**
 * Fake Stoma nodes for demos: backfills plausible history, then optionally keeps sending live.
 * Goes through the same ingest as POST /api/push, from a source named "Simulatore Stoma".
 *   npx tsx scripts/simulate-stoma.ts <org-slug> [--nodes 3] [--hours 48] [--live]
 */
import "./env";
import { crossTenantDb } from "../lib/engine/db";
import { ingestPush } from "../lib/engine/ingest";
import { createSource, type Source } from "../lib/engine/sources";
import { getPackage } from "../lib/packages";

const args = process.argv.slice(2);
const slug = args[0];
const opt = (name: string, def: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : def);
const nodes = opt("--nodes", 3);
const hours = opt("--hours", 48);
const live = args.includes("--live");
const STEP_MIN = 10;
const SOURCE_NAME = "Simulatore Stoma";
if (!slug || slug.startsWith("--")) {
  console.error("usage: simulate-stoma.ts <org-slug> [--nodes 3] [--hours 48] [--live]");
  process.exit(1);
}

const noise = (a: number) => (Math.random() - 0.5) * 2 * a;

/** One reading of node n at time ts: daily cycle, irrigation at 7:00, a warmer node 2. */
function reading(n: number, ts: Date) {
  const h = ts.getHours() + ts.getMinutes() / 60;
  const day = Math.max(0, Math.sin(((h - 6) / 14) * Math.PI)); // 0 at night, 1 at 13:00
  const temp = 14 + 13 * day + n * 0.8 + noise(0.4);
  const irrigation = h >= 7 && h < 7.4 ? 14 : 0;
  const rh = Math.min(99, 90 - 32 * day + irrigation + noise(1.5));
  const lux = day * (38000 + noise(6000));
  const leaf = temp - 0.6 + day * (n === 2 ? 3 : 1) + noise(0.3);
  const ir = Array.from({ length: 16 * 12 }, (_, i) => {
    const hot = n === 2 && i % 16 > 10 && Math.floor(i / 16) < 4 ? 4 : 0;
    return Math.round((leaf + hot + noise(0.6)) * 10) / 10;
  });
  return {
    node_id: `sim-${n + 1}`,
    temp_c: temp,
    rh,
    lux: Math.max(0, lux),
    uvi: day * 6,
    co2: 420 + (1 - day) * 380 + noise(25),
    voc: 80 + noise(20),
    ir_w: 16,
    ir_h: 12,
    ir,
  };
}

async function main() {
  const pool = crossTenantDb("maintenance");
  const pkg = getPackage("stoma");
  if (!pkg) throw new Error(`module "stoma" is not installed`);
  const { rows: orgs } = await pool.query<{ id: string }>(`select id from organizations where slug = $1`, [slug]);
  if (!orgs[0]) throw new Error(`no organization "${slug}"`);
  const tenantId = orgs[0].id;
  const cols = `id, tenant_id, name, connector, module, config, status`;
  let { rows: [source] } = await pool.query<Source>(
    `select ${cols} from sources where tenant_id = $1 and module = 'stoma' and name = $2`, [tenantId, SOURCE_NAME],
  );
  source ??= (await createSource(pool, { tenantId, module: "stoma", name: SOURCE_NAME })).source;

  const send = (ts: Date) => ingestPush(pool, source, Array.from({ length: nodes }, (_, n) => reading(n, ts)), pkg, ts);

  const now = Date.now();
  const start = now - hours * 3600_000;
  let alerts = 0;
  for (let t = start; t <= now; t += STEP_MIN * 60_000) alerts += (await send(new Date(t))).alerts.opened;
  console.log(`${nodes} nodes, ${hours} h of history every ${STEP_MIN} min, ${alerts} alerts opened`);

  if (!live) return pool.end();
  console.log("live: one reading per node every minute (Ctrl+C to stop)");
  setInterval(() => send(new Date()).then((r) => console.log(new Date().toLocaleTimeString(), `${r.metrics} metrics`)), 60_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
