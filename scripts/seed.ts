/**
 * Demo data for local development and sales demos.
 *   npx tsx scripts/seed.ts            (reads .env.local)
 * Creates: VDX admin, demo customer with its owner, 3 greenhouses with one Stoma each,
 * 7 days of synthetic readings (day/night cycle, morning irrigation, dawn condensation in
 * Serra 3), a gateway with a known key. Safe to re-run: the demo customer is recreated.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { stoma } from "../lib/modules/stoma";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const ADMIN = { email: "admin@vdx.local", password: "vdx-admin-2026" };
const OWNER = { email: "owner@demo.local", password: "demo-2026" };
const GATEWAY_KEY = "demo-gateway-key-0001";
// each greenhouse has its own crop, so each Stoma has its own thresholds
const CROPS: Record<number, typeof stoma.defaultConfig> = {
  1: { ...stoma.defaultConfig },
  2: { ...stoma.defaultConfig, tMin: 12, tMax: 28 }, // seedlings
  3: { ...stoma.defaultConfig, rhMax: 80, leafDewWarn: 3 }, // flowering, mould-sensitive
};

async function user(email: string, password: string) {
  const { data: list } = await db.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);
  if (found) return found.id;
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  return data.user.id;
}

function must<T>(r: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (r.error) throw new Error(r.error.message);
  return r.data as NonNullable<T>;
}

async function main() {
  const adminId = await user(ADMIN.email, ADMIN.password);
  await db.from("platform_admins").upsert({ user_id: adminId });
  const ownerId = await user(OWNER.email, OWNER.password);

  await db.from("organizations").delete().eq("slug", "demo");
  const org = must(await db.from("organizations").insert({ name: "Vivai Demo", slug: "demo", locale: "it" }).select().single());
  must(await db.from("memberships").insert({ org_id: org.id, user_id: ownerId, role: "owner" }));
  must(await db.from("org_modules").insert({ org_id: org.id, module: "stoma", config: {} }));
  must(
    await db.from("gateways").insert({
      org_id: org.id,
      name: "Ufficio",
      key_hash: createHash("sha256").update(GATEWAY_KEY).digest("hex"),
      key_hint: GATEWAY_KEY.slice(-4),
    }),
  );
  const site = must(await db.from("sites").insert({ org_id: org.id, name: "Sede" }).select().single());

  const now = Date.now();
  const STEP = 10 * 60 * 1000;
  for (let g = 1; g <= 3; g++) {
    const zone = must(await db.from("zones").insert({ org_id: org.id, site_id: site.id, name: `Serra ${g}` }).select().single());
    const dev = must(
      await db
        .from("devices")
        .insert({ org_id: org.id, zone_id: zone.id, module: "stoma", serial: String(g), name: `Stoma ${g}`, config: CROPS[g] })
        .select()
        .single(),
    );
    let prev: { ts: string; values: Record<string, number | null>; meta: Record<string, unknown> } | null = null;
    const rows = [];
    let last: ReturnType<typeof stoma.ingest> | null = null;
    for (let t = now - 7 * 24 * 3600 * 1000; t <= now; t += STEP) {
      const d = new Date(t);
      const h = d.getHours() + d.getMinutes() / 60;
      const day = Math.max(0, Math.sin(((h - 6) / 14) * Math.PI)); // 6:00 -> 20:00
      const noise = () => (Math.random() - 0.5);
      const temp = 13 + g * 0.6 + 15 * day + noise() * 0.6;
      let rh = 80 - 32 * day + noise() * 2;
      if (h >= 7 && h < 7.34) rh = 99; // irrigation boom
      // Serra 3 cools more at dawn: leaves below the air -> condensation
      const leaf = temp - (day > 0.1 ? -1.2 * day : [0, 0.8, 1.0, 2.6][g]) + noise() * 0.2;
      const lux = 42000 * day ** 1.3 * (0.85 + 0.15 * Math.random());
      const co2 = day > 0.2 ? 420 - 140 * day * (g === 2 ? 1 : 0.5) : 560 + noise() * 30;
      const payload = {
        node_id: g,
        temp_c: temp,
        rh: Math.min(100, rh),
        leaf_c: leaf,
        co2,
        voc: 100 + 40 * Math.max(0, noise()),
        lux,
        uvi: 1.4 * day,
        rssi: -92 - g * 6,
        snr: 7 - g,
      };
      const res = stoma.ingest(payload, CROPS[g], prev, d);
      rows.push({ org_id: org.id, device_id: dev.id, ts: d.toISOString(), values: res.values, status: res.status, meta: res.meta });
      prev = { ts: d.toISOString(), values: res.values, meta: res.meta };
      last = res;
    }
    for (let i = 0; i < rows.length; i += 500) must(await db.from("readings").insert(rows.slice(i, i + 500)));
    await db
      .from("devices")
      .update({ last_seen: prev!.ts, last_status: last!.status, last_values: last!.values })
      .eq("id", dev.id);
    if (last!.alerts.length)
      must(
        await db.from("alerts").insert(
          last!.alerts.map((a) => ({ org_id: org.id, device_id: dev.id, level: a.level, code: `stoma.${a.code}`, params: a.params ?? {} })),
        ),
      );
    console.log(`Serra ${g}: ${rows.length} readings, now ${last!.status}`);
  }
  // a past, resolved alert for the timeline
  await db.from("dashboards").upsert({ org_id: org.id, layout: [] });
  console.log(`\nVDX admin:  ${ADMIN.email} / ${ADMIN.password}`);
  console.log(`Customer:   ${OWNER.email} / ${OWNER.password}`);
  console.log(`Gateway key: ${GATEWAY_KEY}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
