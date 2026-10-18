import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getT, timeAgo } from "@/lib/i18n";
import { crossTenantDb } from "@/lib/engine/db";
import { dbBytes, monthUsage, type HealthReport } from "@/lib/engine/health";
import { getSettings, num } from "@/lib/engine/settings";
import { createSource, rotateToken } from "@/lib/engine/sources";
import { packageIds } from "@/lib/packages";
import { SectionTitle } from "@/components/ui";

const PATH = "/admin/engine";

// Shown once on the next render, then gone.
async function showToken(token: string) {
  (await cookies()).set("new_source_token", token, { path: PATH, maxAge: 120, httpOnly: true, sameSite: "strict" });
  redirect(PATH);
}

async function addSource(formData: FormData) {
  "use server";
  await requireAdmin();
  const { token } = await createSource(crossTenantDb("admin"), {
    tenantId: String(formData.get("org")),
    module: String(formData.get("module")),
    name: String(formData.get("name")).trim(),
  });
  await showToken(token);
}

async function newToken(formData: FormData) {
  "use server";
  await requireAdmin();
  await showToken(await rotateToken(crossTenantDb("admin"), String(formData.get("id"))));
}

async function setStatus(formData: FormData) {
  "use server";
  await requireAdmin();
  const status = formData.get("status") === "paused" ? "paused" : "active";
  await crossTenantDb("admin").query(`update sources set status = $2 where id = $1`, [String(formData.get("id")), status]);
  revalidatePath(PATH);
}

const fmtBytes = (n: number) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  for (; n >= 1024 && i < u.length - 1; i++) n /= 1024;
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};

function QuotaBar({ label, used, limit, ratio, bytes }: { label: string; used: number; limit: number; ratio: number; bytes: boolean }) {
  const f = Math.min(1, used / limit);
  const color = f >= 1 ? "bg-alarm" : f >= ratio ? "bg-warn" : "bg-ok";
  const show = bytes ? fmtBytes : (n: number) => n.toLocaleString();
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="num text-dim">{Math.round(f * 100)}%</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line">
        <div className={`h-full ${color}`} style={{ width: `${f * 100}%` }} />
      </div>
      <div className="num mt-2 text-xs text-dim">
        {show(used)} / {show(limit)}
      </div>
    </div>
  );
}

export default async function EnginePage() {
  await requireAdmin();
  const { t, locale } = await getT();
  const db = crossTenantDb("admin");
  const s = await getSettings(db);
  const [usage, dbSize, sources, jobs, notices, orgs] = await Promise.all([
    monthUsage(db),
    dbBytes(db),
    db.query<{ id: string; name: string; org: string; module: string; status: string; token_hint: string | null; last_seen: Date | null; last_error: string | null }>(
      `select s.id, s.name, o.name org, s.module, s.status, s.token_hint, s.last_seen, s.last_error
       from sources s join organizations o on o.id = s.tenant_id order by o.name, s.name`,
    ),
    db.query<{ name: string; last_run: Date | null; last_ok: Date | null; last_error: string | null; last_duration_ms: number | null; last_result: unknown }>(
      `select name, last_run, last_ok, last_error, last_duration_ms, last_result from engine_jobs order by name`,
    ),
    db.query<{ key: string; message: string; opened_at: Date }>(
      `select key, message, opened_at from engine_notices where resolved_at is null order by opened_at`,
    ),
    db.query<{ id: string; name: string }>(`select id, name from organizations order by name`),
  ]);
  const health = jobs.rows.find((j) => j.name === "health")?.last_result as HealthReport | undefined;
  const ratio = num(s, "quota.alert_ratio", 0.8);
  const newTok = (await cookies()).get("new_source_token")?.value;
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  const quotas = [
    { label: "Database", used: dbSize, limit: num(s, "quota.db_bytes", 524288000), bytes: true },
    ...(health?.r2 ? [{ label: "R2", used: health.r2.bytes, limit: num(s, "quota.r2_bytes", 10737418240), bytes: true }] : []),
    { label: "R2 class A / month", used: usage["r2.writes"] ?? 0, limit: num(s, "quota.r2_writes_month", 1000000), bytes: false },
    { label: "R2 class B / month", used: usage["r2.reads"] ?? 0, limit: num(s, "quota.r2_reads_month", 10000000), bytes: false },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t.engine}</h1>

      <SectionTitle right={<span className="text-xs text-dim">{health ? `${t.measuredAt} ${timeAgo(health.at, locale, t)}` : t.notMeasured}</span>}>
        {t.quotas}
      </SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {quotas.map((q) => (
          <QuotaBar key={q.label} {...q} ratio={ratio} />
        ))}
      </div>

      <SectionTitle>{t.openProblems}</SectionTitle>
      <div className="card p-5 text-sm">
        {notices.rows.length ? (
          <ul className="space-y-1">
            {notices.rows.map((n) => (
              <li key={n.key} className="flex flex-wrap gap-x-3">
                <span className="text-alarm">{n.message}</span>
                <span className="text-xs text-dim">{timeAgo(iso(n.opened_at), locale, t)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-mist">{t.noProblems}</span>
        )}
      </div>

      <SectionTitle>{t.sources}</SectionTitle>
      <div className="card overflow-x-auto p-5">
        {newTok && (
          <div className="mb-4 rounded-lg border border-warn/50 bg-warn/10 p-3 text-sm">
            {t.keyOnce} <code className="num select-all text-frost">{newTok}</code>
          </div>
        )}
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-dim">
            <tr>
              <th className="pb-2 font-normal">{t.name}</th>
              <th className="pb-2 font-normal">{t.customers}</th>
              <th className="pb-2 font-normal">{t.status}</th>
              <th className="pb-2 font-normal">{t.lastSeen}</th>
              <th className="pb-2 font-normal">{t.lastError}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sources.rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="py-2 pr-4">
                  <div className="font-medium">{r.name}</div>
                  <div className="num text-xs text-dim">
                    {r.module} · …{r.token_hint}
                  </div>
                </td>
                <td className="py-2 pr-4 text-mist">{r.org}</td>
                <td className={`py-2 pr-4 ${r.status === "active" ? "text-ok" : "text-warn"}`}>{r.status}</td>
                <td className="py-2 pr-4 text-mist">{timeAgo(iso(r.last_seen), locale, t)}</td>
                <td className="max-w-xs py-2 pr-4 text-xs text-alarm">{r.last_error}</td>
                <td className="py-2">
                  <div className="flex justify-end gap-2">
                    <form action={setStatus}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value={r.status === "paused" ? "active" : "paused"} />
                      <button className="btn text-xs">{r.status === "paused" ? t.resume : t.pause}</button>
                    </form>
                    <form action={newToken}>
                      <input type="hidden" name="id" value={r.id} />
                      <button className="btn text-xs">{t.newToken}</button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={addSource} className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4">
          <input name="name" placeholder={t.newSource} required />
          <select name="org" required>
            {orgs.rows.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select name="module">
            {packageIds().map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <button className="btn">{t.create}</button>
        </form>
      </div>

      <SectionTitle>{t.jobs}</SectionTitle>
      <div className="card overflow-x-auto p-5">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-dim">
            <tr>
              <th className="pb-2 font-normal">{t.name}</th>
              <th className="pb-2 font-normal">{t.lastRun}</th>
              <th className="pb-2 font-normal">{t.duration}</th>
              <th className="pb-2 font-normal">{t.lastError}</th>
            </tr>
          </thead>
          <tbody>
            {jobs.rows.map((j) => (
              <tr key={j.name} className="border-t border-line align-top">
                <td className={`py-2 pr-4 font-medium ${j.last_error ? "text-alarm" : ""}`}>{j.name}</td>
                <td className="py-2 pr-4 text-mist">{timeAgo(iso(j.last_run), locale, t)}</td>
                <td className="num py-2 pr-4 text-mist">{j.last_duration_ms ?? "–"} ms</td>
                <td className="py-2 text-xs text-alarm">{j.last_error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
