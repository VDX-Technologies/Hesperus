import { requireAdmin } from "@/lib/auth";
import { getT, timeAgo } from "@/lib/i18n";
import { crossTenantAccess, crossTenantDb } from "@/lib/engine/db";
import { SectionTitle } from "@/components/ui";

// Anonymous, opt-in telemetry sent by VDX Agent installs (tables agent_installs / agent_turns,
// written by POST /api/agent/telemetry). Not tied to any organisation.

const RANGES = [7, 30, 90] as const;

type ModelRow = {
  model: string; quantization: string; turns: number; installs: number; tps: number | null;
  p50_ms: number | null; p95_ms: number | null; load_ms: number | null; gpu_ms: number | null; cpu_ms: number | null; ok_rate: number;
};
type ChipRow = { chip: string; ram_gb: number; model: string; turns: number; tps: number | null; p50_ms: number | null };
type InstallRow = { id: string; mac_model: string; chip: string; ram_gb: number; macos: string; app_version: string; ollama: string; last_seen: Date; turns: number };

const ms = (v: number | null) => (v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const n1 = (v: number | null) => (v == null ? "—" : v.toFixed(1));

export default async function AgentTelemetryPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  await requireAdmin();
  const { t, locale } = await getT();
  const d = Number((await searchParams).days);
  const days = RANGES.includes(d as never) ? d : 30;
  const db = crossTenantDb(crossTenantAccess.admin);
  const since = `now() - make_interval(days => $1)`;
  
  const [totals, models, chips, installs] = await Promise.all([
    db.query<{ turns: number; installs: number; tokens: number; ok_rate: number | null; tps: number | null }>(
      `select count(*)::int turns, count(distinct e.install_id)::int installs,
              coalesce(sum(e.completion_tokens), 0)::float tokens,
              avg(case when e.ok then 1 else 0 end)::float ok_rate,
              percentile_cont(0.5) within group (order by e.tokens_per_s) filter (where e.tokens_per_s > 0) tps
       from agent_turns e
       where e.ts > ${since}`, [days]),
    db.query<ModelRow>(
      `select e.model, e.quantization,
              count(*)::int turns, count(distinct e.install_id)::int installs,
              percentile_cont(0.5) within group (order by e.tokens_per_s) filter (where e.tokens_per_s > 0) tps,
              percentile_cont(0.5) within group (order by e.duration_ms) p50_ms,
              percentile_cont(0.95) within group (order by e.duration_ms) p95_ms,
              avg(e.load_ms)::float load_ms, avg(e.gpu_ms)::float gpu_ms, avg(e.cpu_ms)::float cpu_ms,
              avg(case when e.ok then 1 else 0 end)::float ok_rate
       from agent_turns e
       where e.ts > ${since}
       group by 1, 2 order by turns desc limit 50`, [days]),
    db.query<ChipRow>(
      `select coalesce(nullif(i.chip, ''), '?') chip, round(i.ram_gb)::int ram_gb, e.model, count(*)::int turns,
              percentile_cont(0.5) within group (order by e.tokens_per_s) filter (where e.tokens_per_s > 0) tps,
              percentile_cont(0.5) within group (order by e.duration_ms) p50_ms
       from agent_turns e join agent_installs i on i.id = e.install_id
       where e.ts > ${since}
       group by 1, 2, 3 order by turns desc limit 50`, [days]),
    db.query<InstallRow>(
      `select i.id, i.mac_model, i.chip, i.ram_gb::float ram_gb, i.macos, i.app_version, i.ollama, i.last_seen,
              count(e.id)::int turns
       from agent_installs i left join agent_turns e on e.install_id = i.id and e.ts > ${since}
       group by i.id order by i.last_seen desc limit 100`, [days]),
  ]);
  const tot = totals.rows[0];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">VDX Agent telemetry</h1>
        <div className="flex gap-2">
          {RANGES.map((r) => (
            <a key={r} href={`/admin/agent?days=${r}`} className={`btn text-xs ${r === days ? "" : "text-dim"}`}>{r}d</a>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs text-dim">Anonymous, opt-in data from VDX Agent installs. No prompts, content or IP addresses.</p>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ["Requests", String(tot?.turns ?? 0)],
          ["Installs", String(tot?.installs ?? 0)],
          ["Tokens generated", Math.round(tot?.tokens ?? 0).toLocaleString(locale)],
          ["Median tok/s", n1(tot?.tps ?? null)],
          ["Success", tot?.ok_rate == null ? "—" : `${Math.round(tot.ok_rate * 100)}%`],
        ].map(([label, value]) => (
          <div key={label} className="card p-4">
            <div className="text-xs text-dim">{label}</div>
            <div className="num mt-1 text-xl">{value}</div>
          </div>
        ))}
      </div>

      <SectionTitle>Models</SectionTitle>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-dim">
            <tr>{["Model", "Quant", "Requests", "Installs", "tok/s p50", "Latency p50", "p95", "Load", "GPU", "CPU", "OK"].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
          </thead>
          <tbody>
            {models.rows.map((m) => (
              <tr key={m.model + m.quantization} className="border-t border-white/5">
                <td className="px-3 py-2 font-mono text-xs">{m.model}</td>
                <td className="px-3 py-2 text-dim">{m.quantization || "—"}</td>
                <td className="num px-3 py-2">{m.turns}</td>
                <td className="num px-3 py-2">{m.installs}</td>
                <td className="num px-3 py-2">{n1(m.tps)}</td>
                <td className="num px-3 py-2">{ms(m.p50_ms)}</td>
                <td className="num px-3 py-2">{ms(m.p95_ms)}</td>
                <td className="num px-3 py-2">{ms(m.load_ms)}</td>
                <td className="num px-3 py-2">{ms(m.gpu_ms)}</td>
                <td className="num px-3 py-2">{ms(m.cpu_ms)}</td>
                <td className="num px-3 py-2">{Math.round(m.ok_rate * 100)}%</td>
              </tr>
            ))}
            {!models.rows.length && <tr><td colSpan={11} className="px-3 py-6 text-center text-dim">No data yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <SectionTitle>Hardware × model</SectionTitle>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-dim">
            <tr>{["Chip", "RAM", "Model", "Requests", "tok/s p50", "Latency p50"].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
          </thead>
          <tbody>
            {chips.rows.map((c) => (
              <tr key={`${c.chip}${c.ram_gb}${c.model}`} className="border-t border-white/5">
                <td className="px-3 py-2">{c.chip}</td>
                <td className="num px-3 py-2">{c.ram_gb} GB</td>
                <td className="px-3 py-2 font-mono text-xs">{c.model}</td>
                <td className="num px-3 py-2">{c.turns}</td>
                <td className="num px-3 py-2">{n1(c.tps)}</td>
                <td className="num px-3 py-2">{ms(c.p50_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle>Installs</SectionTitle>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-dim">
            <tr>{["Install", "Mac", "Chip", "RAM", "macOS", "App", "Ollama", "Requests", "Last seen"].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
          </thead>
          <tbody>
            {installs.rows.map((i) => (
              <tr key={i.id} className="border-t border-white/5">
                <td className="px-3 py-2 font-mono text-xs">{i.id.slice(0, 8)}</td>
                <td className="px-3 py-2">{i.mac_model}</td>
                <td className="px-3 py-2">{i.chip}</td>
                <td className="num px-3 py-2">{i.ram_gb} GB</td>
                <td className="px-3 py-2">{i.macos}</td>
                <td className="px-3 py-2">{i.app_version}</td>
                <td className="px-3 py-2">{i.ollama}</td>
                <td className="num px-3 py-2">{i.turns}</td>
                <td className="px-3 py-2 text-dim">{timeAgo(new Date(i.last_seen).toISOString(), locale, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
