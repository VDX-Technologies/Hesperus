// Compatibility for gateways still posting to /api/ingest: once an organization is migrated
// (its gateway key is a source token), payloads go through the engine and the answer keeps the
// shape current firmware expects. The legacy tables are not written any more.
import type { Db } from "../../engine/db";
import { ingestPush } from "../../engine/ingest";
import { deviceConfig, loadRules } from "../../engine/rules";
import type { Source } from "../../engine/sources";
import { legacyDeviceConfig, stomaPackage } from ".";

export type LegacyResult =
  | { device_id: string; serial: string; status: "ok" | "warn" | "alarm"; alerts: number; config: Record<string, number> }
  | { error: string; status: number };

export async function ingestLegacy(db: Db, source: Source, items: unknown[], now = new Date()): Promise<LegacyResult[]> {
  const out: LegacyResult[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      out.push({ error: "invalid payload", status: 400 });
      continue;
    }
    const msg = item as Record<string, unknown>;
    if (typeof msg.module === "string" && msg.module !== "stoma") {
      out.push({ error: `unknown module ${msg.module}`, status: 400 });
      continue;
    }
    const r = await ingestPush(db, source, [msg], stomaPackage, now);
    if (r.rejected.length) {
      out.push({ error: r.rejected[0].error, status: 400 });
      continue;
    }
    const serial = String(msg.node_id);
    const { rows: [o] } = await db.query<{ id: string; alerts: number; alarm: boolean }>(
      `select o.id, count(a.id)::int as alerts, coalesce(bool_or(a.severity = 'alarm'), false) as alarm
       from objects o join object_types t on t.id = o.type_id and t.module = 'stoma' and t.key = 'node'
       left join object_alerts a on a.object_id = o.id and a.status <> 'resolved'
       where o.tenant_id = $1 and o.external_id = $2 group by o.id`,
      [source.tenant_id, serial],
    );
    const cfg = deviceConfig(await loadRules(db, source.tenant_id, "stoma"), "node", o.id);
    out.push({
      device_id: o.id,
      serial,
      status: o.alarm ? "alarm" : o.alerts ? "warn" : "ok",
      alerts: o.alerts,
      config: legacyDeviceConfig(cfg ?? { version: 0, thresholds: {} }),
    });
  }
  return out;
}
