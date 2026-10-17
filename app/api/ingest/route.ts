/**
 * POST /api/ingest - data from VDX gateways.
 * Auth: "Authorization: Bearer <gateway key>" (or "X-Api-Key"). Body: one payload or an array.
 * A payload without "module" is treated as Stoma (current gateway firmware).
 * Gateways of migrated organizations are engine sources: their payloads go through the Stoma
 * package; the others still use the legacy tables until their organization is migrated.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { hashKey, IngestError, ingestPayload } from "@/lib/ingest";
import { getPool } from "@/lib/engine/db";
import { ValidationError } from "@/lib/engine/package";
import { sourceByToken } from "@/lib/engine/sources";
import { ingestLegacy } from "@/lib/packages/stoma/legacy";

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  const key = auth?.startsWith("Bearer ") ? auth.slice(7) : request.headers.get("x-api-key");
  if (!key) return Response.json({ error: "missing gateway key" }, { status: 401 });

  const source = await sourceByToken(getPool(), key);
  if (source) return engineIngest(request, source);

  const db = createAdminClient();
  const { data: gw } = await db.from("gateways").select("id, org_id").eq("key_hash", hashKey(key)).maybeSingle();
  if (!gw) return Response.json({ error: "invalid gateway key" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const items = Array.isArray(body) ? body : [body];
  const results = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      results.push({ error: "invalid payload" });
      continue;
    }
    try {
      results.push(await ingestPayload(db, gw.org_id, item as Record<string, unknown>));
    } catch (e) {
      if (e instanceof IngestError) results.push({ error: e.message, status: e.status });
      else throw e;
    }
  }
  await db.from("gateways").update({ last_seen: new Date().toISOString() }).eq("id", gw.id);
  const failed = results.filter((r) => "error" in r);
  return Response.json({ ok: failed.length === 0, results }, { status: failed.length === items.length ? 400 : 200 });
}

async function engineIngest(request: Request, source: NonNullable<Awaited<ReturnType<typeof sourceByToken>>>) {
  if (source.status === "paused") return Response.json({ error: "source is paused" }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const items = Array.isArray(body) ? body : [body];
  try {
    const results = await ingestLegacy(getPool(), source, items);
    const failed = results.filter((r) => "error" in r);
    return Response.json({ ok: failed.length === 0, results }, { status: failed.length === items.length ? 400 : 200 });
  } catch (e) {
    if (e instanceof ValidationError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
