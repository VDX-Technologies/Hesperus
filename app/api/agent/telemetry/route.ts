/**
 * POST /api/agent/telemetry - anonymous, opt-in telemetry from VDX Agent (no token: the app is
 * open source, so any embedded secret would be public anyway).
 * Body: { install: { id, app_version, mac_model, chip, ... }, turns: [{ ts, model, ... }] }.
 * Writes only agent_installs / agent_turns (migration agent_telemetry), read by /admin/agent.
 * Every field is whitelisted, typed and clamped; the caller's address is never read or stored.
 * Abuse limits: 64 KB body, 100 turns per request, MAX_PER_HOUR turns per install.
 */
import { crossTenantAccess, crossTenantDb } from "@/lib/engine/db";

const MAX_BODY = 64_000;
const MAX_TURNS = 100;
const MAX_PER_HOUR = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Rec = Record<string, unknown>;
const str = (v: unknown, max = 64) => (typeof v === "string" ? v.slice(0, max) : "");
const int = (v: unknown, max = 2_147_483_647) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0;
const big = (v: unknown) => int(v, Number.MAX_SAFE_INTEGER);
const real = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1e6, Math.max(0, v)) : 0);

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** A turn timestamp, accepted only within the last 7 days (queued offline batches) and not in the future. */
function when(v: unknown): string | null {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  const now = Date.now();
  return Number.isFinite(t) && t <= now + 300_000 && t >= now - 7 * 86_400_000 ? new Date(t).toISOString() : null;
}

export async function POST(request: Request) {
  const text = await request.text().catch(() => "");
  if (!text || text.length > MAX_BODY) return bad("body missing or too large", 413);
  let body: Rec;
  try {
    body = JSON.parse(text);
  } catch {
    return bad("invalid JSON");
  }
  const install = (body?.install ?? {}) as Rec;
  const id = str(install.id, 36);
  if (!UUID.test(id)) return bad("install.id must be a uuid");
  const turns = Array.isArray(body.turns) ? (body.turns as Rec[]).slice(0, MAX_TURNS) : [];

  const db = crossTenantDb(crossTenantAccess.ingest);
  await db.query(
    `insert into agent_installs (id, app_version, mac_model, chip, cpu_cores, ram_gb, macos, python, ollama)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (id) do update set app_version = excluded.app_version, mac_model = excluded.mac_model,
       chip = excluded.chip, cpu_cores = excluded.cpu_cores, ram_gb = excluded.ram_gb, macos = excluded.macos,
       python = excluded.python, ollama = excluded.ollama, last_seen = now()`,
    [id, str(install.app_version, 32), str(install.mac_model), str(install.chip), int(install.cpu_cores, 1024),
     real(install.ram_gb), str(install.macos, 32), str(install.python, 32), str(install.ollama, 32)],
  );

  const rows = turns.flatMap((t) => {
    const ts = when(t?.ts);
    const model = str(t?.model, 128);
    return ts && model ? [{
      ts, model, family: str(t.family), parameter_size: str(t.parameter_size, 16), quantization: str(t.quantization, 16),
      model_bytes: big(t.model_bytes), vram_bytes: big(t.vram_bytes),
      prompt_tokens: int(t.prompt_tokens), completion_tokens: int(t.completion_tokens),
      duration_ms: int(t.duration_ms), load_ms: int(t.load_ms), prompt_ms: int(t.prompt_ms),
      gpu_ms: int(t.gpu_ms), cpu_ms: int(t.cpu_ms), tokens_per_s: real(t.tokens_per_s),
      tools: int(t.tools, 1000), ok: t.ok !== false,
    }] : [];
  });
  if (!rows.length) return Response.json({ ok: true, accepted: 0 });

  const { rows: [recent] } = await db.query<{ n: number }>(
    `select count(*)::int n from agent_turns where install_id = $1 and recorded_at > now() - interval '1 hour'`, [id]);
  if (recent.n + rows.length > MAX_PER_HOUR) return bad("rate limit", 429);

  const { rowCount } = await db.query(
    `insert into agent_turns (install_id, ts, model, family, parameter_size, quantization, model_bytes, vram_bytes,
       prompt_tokens, completion_tokens, duration_ms, load_ms, prompt_ms, gpu_ms, cpu_ms, tokens_per_s, tools, ok)
     select $1, r.* from jsonb_to_recordset($2::jsonb) as r(ts timestamptz, model text, family text,
       parameter_size text, quantization text, model_bytes bigint, vram_bytes bigint, prompt_tokens int,
       completion_tokens int, duration_ms int, load_ms int, prompt_ms int, gpu_ms int, cpu_ms int,
       tokens_per_s real, tools int, ok boolean)
     on conflict (install_id, ts) do nothing`,
    [id, JSON.stringify(rows)],
  );
  return Response.json({ ok: true, accepted: rowCount ?? 0 });
}
