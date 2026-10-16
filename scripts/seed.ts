/**
 * Demo data for local development and sales demos.
 *   npx tsx scripts/seed.ts            (reads .env.local)
 * Creates: VDX admin, demo customer with its owner, 3 greenhouses with one Stoma each,
 * 7 days of synthetic readings (day/night cycle, morning irrigation, dawn condensation in
 * Serra 3), a 16x12 infrared frame per reading, a gateway with a known key.
 * Disease scenarios: Serra 1 warm days (powdery mildew), Serra 2 midday water stress with a dry
 * hot patch in the infrared, Serra 3 humid nights (botrytis, downy mildew). Safe to re-run: the demo customer is recreated.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { stoma } from "../lib/modules/stoma";
import { IR_H, IR_W, irFrame } from "../lib/modules/stoma/ir-sim";

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
// DEMO_LANG=en seeds English names (marketing screenshots); default stays Italian.
const EN = process.env.DEMO_LANG === "en";
const DEMO_HOUR = process.env.DEMO_HOUR ? Number(process.env.DEMO_HOUR) : null;
const NAMES = EN
  ? { org: "Greenhouse Demo", locale: "en", gateway: "Office", site: "Main site", zone: "Greenhouse" }
  : { org: "Vivai Demo", locale: "it", gateway: "Ufficio", site: "Sede", zone: "Serra" };
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
  const org = must(await db.from("organizations").insert({ name: NAMES.org, slug: "demo", locale: NAMES.locale }).select().single());
  must(await db.from("memberships").insert({ org_id: org.id, user_id: ownerId, role: "owner" }));
  must(await db.from("org_modules").insert({ org_id: org.id, module: "stoma", config: {} }));
  must(
    await db.from("gateways").insert({
      org_id: org.id,
      name: NAMES.gateway,
      key_hash: createHash("sha256").update(GATEWAY_KEY).digest("hex"),
      key_hint: GATEWAY_KEY.slice(-4),
    }),
  );
  const site = must(await db.from("sites").insert({ org_id: org.id, name: NAMES.site }).select().single());

  const now = Date.now();
  const STEP = 10 * 60 * 1000;
  for (let g = 1; g <= 3; g++) {
    const zone = must(await db.from("zones").insert({ org_id: org.id, site_id: site.id, name: `${NAMES.zone} ${g}` }).select().single());
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
    // alert timeline: an alert opens when its condition appears and resolves when it clears
    const open = new Map<string, { ts: string; level: string; params: Record<string, number | string> }>();
    const history: Record<string, unknown>[] = [];
    for (let t = now - 7 * 24 * 3600 * 1000; t <= now; t += STEP) {
      const d = new Date(t);
      // DEMO_HOUR=5.5 replays the day as if "now" were 05:30 (dawn alerts), timestamps stay real
      const sim = DEMO_HOUR == null ? d : new Date(t + (DEMO_HOUR - (new Date(now).getHours() + new Date(now).getMinutes() / 60)) * 3600 * 1000);
      const h = sim.getHours() + sim.getMinutes() / 60;
      const day = Math.max(0, Math.sin(((h - 6) / 14) * Math.PI)); // 6:00 -> 20:00
      const noise = () => (Math.random() - 0.5);
      const temp = 13 + g * 0.6 + (g === 1 ? 15 : 6) * day + noise() * 0.6;
      let rh = 80 - 32 * day + noise() * 2 + (g === 3 ? 14 * (1 - day) : 0); // Serra 3 humid nights
      if (h >= 7 && h < 7.34) rh = 99; // irrigation boom
      // Serra 3 cools more at dawn: leaves below the air -> condensation
      let leaf = temp - (day > 0.1 ? -1.2 * day : [0, 0.8, 1.0, 2.6][g]) + noise() * 0.2;
      if (g === 2 && day > 0.6) leaf += 2.2 * day; // midday water stress: stomata close, leaf heats up
      const temp1 = g === 1 ? temp + 3 * day : temp; // Serra 1 runs warm (powdery mildew)
      const lux = 42000 * day ** 1.3 * (0.85 + 0.15 * Math.random());
      const co2 = day > 0.2 ? 420 - 140 * day * (g === 2 ? 1 : 0.5) : 560 + noise() * 30;
      const payload = {
        node_id: g,
        temp_c: temp1,
        rh: Math.min(100, rh),
        leaf_c: leaf,
        co2,
        voc: 100 + 40 * Math.max(0, noise()),
        lux,
        uvi: 1.4 * day,
        rssi: -92 - g * 6,
        snr: 7 - g,
        ir: irFrame(leaf, temp1, day, g === 2 ? 4 * day : 0, g === 3 && day < 0.1 ? 1.2 : 0),
        ir_w: IR_W,
        ir_h: IR_H,
      };
      const res = stoma.ingest(payload, CROPS[g], prev, d);
      rows.push({ org_id: org.id, device_id: dev.id, ts: d.toISOString(), values: res.values, status: res.status, meta: res.meta });
      prev = { ts: d.toISOString(), values: res.values, meta: res.meta };
      const active = new Set(res.alerts.map((a) => a.code));
      for (const a of res.alerts) if (!open.has(a.code)) open.set(a.code, { ts: d.toISOString(), level: a.level, params: a.params ?? {} });
      for (const [code, a] of open)
        if (!active.has(code)) {
          // short blips (< 30 min) would just be noise in the demo timeline
          if (t - Date.parse(a.ts) >= 30 * 60 * 1000)
            history.push({ org_id: org.id, device_id: dev.id, ts: a.ts, level: a.level, code: `stoma.${code}`, params: a.params, resolved_at: d.toISOString() });
          open.delete(code);
        }
      last = res;
    }
    for (let i = 0; i < rows.length; i += 500) must(await db.from("readings").insert(rows.slice(i, i + 500)));
    await db
      .from("devices")
      .update({ last_seen: prev!.ts, last_status: last!.status, last_values: last!.values })
      .eq("id", dev.id);
    for (const [code, a] of open) history.push({ org_id: org.id, device_id: dev.id, ts: a.ts, level: a.level, code: `stoma.${code}`, params: a.params });
    // keep the last 40 resolved per greenhouse so the list stays readable
    const resolved = history.filter((h) => h.resolved_at).slice(-40);
    const rows2 = [...resolved, ...history.filter((h) => !h.resolved_at)];
    if (rows2.length) must(await db.from("alerts").insert(rows2));
    console.log(`Serra ${g}: ${rows.length} readings, ${rows2.length - resolved.length} open + ${resolved.length} resolved alerts, now ${last!.status}`);
  }
  await db.from("dashboards").upsert({ org_id: org.id, layout: [] });
  console.log(`\nVDX admin:  ${ADMIN.email} / ${ADMIN.password}`);
  console.log(`Customer:   ${OWNER.email} / ${OWNER.password}`);
  console.log(`Gateway key: ${GATEWAY_KEY}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
