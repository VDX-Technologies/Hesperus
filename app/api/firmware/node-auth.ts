// The firmware endpoints answer only Heltec nodes: a push source of the lora module, with its token.
import { crossTenantAccess, crossTenantDb, type Db } from "@/lib/engine/db";
import { FIRMWARE_MODULE } from "@/lib/engine/firmware";
import { takeIngestToken } from "@/lib/engine/ingest";
import { sourceByToken } from "@/lib/engine/sources";

export async function nodeSource(request: Request): Promise<{ db: Db } | { error: Response }> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return { error: Response.json({ error: "missing source token" }, { status: 401 }) };
  const db = crossTenantDb(crossTenantAccess.ingest);
  const source = await sourceByToken(db, token);
  if (!source) return { error: Response.json({ error: "invalid source token" }, { status: 401 }) };
  if (source.connector !== "push" || source.module !== FIRMWARE_MODULE)
    return { error: Response.json({ error: "no firmware for this source" }, { status: 403 }) };
  if (source.status === "paused") return { error: Response.json({ error: "source is paused" }, { status: 403 }) };
  const wait = await takeIngestToken(db, source.id);
  if (wait > 0)
    return { error: Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(wait)) } }) };
  return { db };
}
