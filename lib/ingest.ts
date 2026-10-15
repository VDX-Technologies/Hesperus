import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getModule } from "@/lib/modules";

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export class IngestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One payload from a gateway -> reading, device state, alerts.
 * Unknown devices are registered automatically (unassigned) so a new sensor shows up in the
 * console as soon as it is switched on.
 */
export async function ingestPayload(db: SupabaseClient, orgId: string, payload: Record<string, unknown>, now = new Date()) {
  const moduleId = typeof payload.module === "string" ? payload.module : "stoma";
  const mod = getModule(moduleId);
  if (!mod) throw new IngestError(400, `unknown module ${moduleId}`);

  const { data: om } = await db.from("org_modules").select("enabled, config").eq("org_id", orgId).eq("module", moduleId).maybeSingle();
  if (!om?.enabled) throw new IngestError(403, `module ${moduleId} not enabled for this organization`);

  const serial = mod.serialOf(payload);
  if (!serial) throw new IngestError(400, "missing device id");

  let { data: device } = await db
    .from("devices")
    .select("id, config")
    .eq("org_id", orgId)
    .eq("module", moduleId)
    .eq("serial", serial)
    .maybeSingle();
  if (!device) {
    const ins = await db
      .from("devices")
      // a new sensor starts from the company starting values, then keeps its own copy
      .insert({ org_id: orgId, module: moduleId, serial, name: `${mod.name} ${serial}`, config: { ...mod.defaultConfig, ...(om.config ?? {}) } })
      .select("id, config")
      .single();
    if (ins.error) throw new IngestError(500, ins.error.message);
    device = ins.data;
  }

  const { data: prev } = await db
    .from("readings")
    .select("ts, values, meta")
    .eq("device_id", device.id)
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();

  const config = { ...mod.defaultConfig, ...(om.config ?? {}), ...(device.config ?? {}) };
  const res = mod.ingest(payload, config, prev ?? null, now);
  const ts = now.toISOString();

  const r1 = await db
    .from("readings")
    .insert({ org_id: orgId, device_id: device.id, ts, values: res.values, status: res.status, meta: res.meta });
  if (r1.error) throw new IngestError(500, r1.error.message);
  await db.from("devices").update({ last_seen: ts, last_status: res.status, last_values: res.values }).eq("id", device.id);

  // alerts: open new conditions, update the level of running ones, close the cleared ones
  const { data: open } = await db
    .from("alerts")
    .select("id, code, level")
    .eq("device_id", device.id)
    .is("resolved_at", null);
  const active = new Map(res.alerts.map((a) => [`${moduleId}.${a.code}`, a]));
  for (const a of open ?? []) {
    const now_ = active.get(a.code);
    if (!now_) await db.from("alerts").update({ resolved_at: ts }).eq("id", a.id);
    else {
      if (now_.level !== a.level) await db.from("alerts").update({ level: now_.level, params: now_.params ?? {} }).eq("id", a.id);
      active.delete(a.code);
    }
  }
  if (active.size)
    await db.from("alerts").insert(
      [...active.entries()].map(([code, a]) => ({
        org_id: orgId,
        device_id: device.id,
        ts,
        level: a.level,
        code,
        params: a.params ?? {},
      })),
    );

  // settings for the device itself (the gateway forwards them in its next ACK)
  return {
    device_id: device.id,
    serial,
    status: res.status,
    alerts: res.alerts.length,
    ...(mod.deviceConfig ? { config: mod.deviceConfig(config) } : {}),
  };
}
