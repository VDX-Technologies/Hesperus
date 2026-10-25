/**
 * GET /api/cron/engine - the hourly maintenance (raw_inbox flush, then health) as a route, so it
 * does not depend on GitHub Actions alone. Called by Vercel Cron (vercel.json; once a day on the
 * Hobby plan) and by any external scheduler, with `Authorization: Bearer $CRON_SECRET`. Safe
 * next to scripts/flush-raw.ts and scripts/health.ts: the flush claims rows with skip locked and
 * a repeated health run only re-mails problems that are due.
 */
import { timingSafeEqual } from "node:crypto";
import { crossTenantAccess, crossTenantDb } from "@/lib/engine/db";
import { flushRawInbox } from "@/lib/engine/archive";
import { metered, runHealth } from "@/lib/engine/health";
import { mailerFromEnv } from "@/lib/engine/mail";
import { storeFromEnv } from "@/lib/engine/store";

export const maxDuration = 300;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  const given = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!secret || !given) return false;
  const [a, b] = [Buffer.from(given), Buffer.from(secret)];
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const pool = crossTenantDb(crossTenantAccess.maintenance);
  const store = storeFromEnv();
  let flush: { rows: number; objects: number } | { error: string };
  try {
    const out = await metered(pool, store, (s) => flushRawInbox(pool, s));
    flush = { rows: out.rows, objects: out.objects.length };
  } catch (e) {
    console.error("cron flush failed", e);
    flush = { error: String(e) }; // health still runs: that is what it reports
  }
  const { report, mailed } = await metered(pool, store, (s) => runHealth(pool, { store: s, mailer: mailerFromEnv() }));
  const problems = report.checks.filter((c) => !c.ok).length;
  return Response.json({ flush, problems, mailed }, { headers: { "cache-control": "no-store" } });
}
