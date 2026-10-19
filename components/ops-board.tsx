import Link from "next/link";
import type { TenantDb } from "@/lib/engine/db";
import { allEvents } from "@/lib/engine/events";
import { label as nameOf, type EventTypeInfo } from "@/lib/engine/registers";
import { operations, type Figure, type OpsEvent, type OpsObject, type Signal } from "@/lib/engine/ops";
import type { Period } from "@/lib/packages/agronomy/dashboard";
import type { ConsoleAlert } from "@/lib/packages/console";
import type { UploadedDocument } from "@/lib/engine/upload";
import type { Dict } from "@/lib/i18n";
import { timeAgo } from "@/lib/i18n";
import type { Locale } from "@/lib/packages/types";
import { StackChart } from "@/components/chart";
import { StatusDot } from "@/components/ui";

const DAY = 86_400_000;
const PALETTE = ["#9fd8ff", "#7ee0a8", "#f2b84b", "#c49bff", "#ff8f8f", "#5fc9c9", "#e6e18a", "#8fa8ff", "#f5a3d0", "#b0b8c4"];
const label = "text-[11px] uppercase tracking-[0.14em] text-dim";
const panel = "card overflow-hidden";
const head = "flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5";
const act = "rounded border border-line px-2 py-0.5 text-[11px] text-mist hover:border-ice/60 hover:text-frost";

function Delta({ f }: { f: Figure }) {
  if (f.prev === null) return null;
  if (!f.prev) return <span className="text-[11px] text-dim">{f.value ? "new" : "–"}</span>;
  const d = Math.round(((f.value - f.prev) / f.prev) * 100);
  const tone = d > 0 ? "text-ice" : d < 0 ? "text-warn" : "text-dim";
  return <span className={`num text-[11px] ${tone}`}>{d > 0 ? "▲" : d < 0 ? "▼" : "■"} {Math.abs(d)}%</span>;
}

function Spark({ values, tone }: { values: number[]; tone: string }) {
  const w = 96, h = 20, max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block" aria-hidden>
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill={tone} fillOpacity={0.12} stroke="none" />
      <polyline points={pts} fill="none" stroke={tone} strokeWidth={1.2} strokeLinejoin="round" />
    </svg>
  );
}

/** Objects with their kind; crops (what registers are about) are tracked through their cycle. */
async function loadObjects(db: TenantDb, subjects: Set<string>): Promise<OpsObject[]> {
  const { rows } = await db.query<{ id: string; name: string; type: string; hectares: unknown; archived: boolean }>(
    `select o.id, coalesce(o.name, o.external_id, left(o.id::text, 8)) name, t.module || '.' || t.key type,
            o.properties->'hectares' hectares, coalesce(o.properties->>'status', '') = 'archived' archived
       from objects o join object_types t on t.id = o.type_id where o.tenant_id = $1`,
    [db.tenantId],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, hectares: typeof r.hectares === "number" ? r.hectares : null, tracked: subjects.has(r.type) && !r.archived,
  }));
}

/**
 * The organization's operating picture across every register, file and alert: what was done,
 * where, against the period before, each crop's cycle and what needs a look. Modules add their
 * own depth below it.
 */
export async function OpsBoard({
  db, slug, t, locale, period, types, alerts, uploads, now = new Date(),
}: { db: TenantDb; slug: string; t: Dict; locale: Locale; period: Period; types: EventTypeInfo[]; alerts: ConsoleAlert[]; uploads: UploadedDocument[]; now?: Date }) {
  const end = now.getTime() - (now.getTime() % DAY) + DAY;
  const since = period ? new Date(end - 2 * period * DAY) : undefined;
  const events: OpsEvent[] = [];
  const feedRows: { id: number; ts: number; type: string; objectIds: string[]; author: string | null; payload: Record<string, unknown> }[] = [];
  if (types.length)
    for await (const e of allEvents(db, { types: types.map((x) => x.type), from: since })) {
      events.push({ id: e.id, ts: e.ts.getTime(), type: e.type, objectIds: e.objectIds, payload: e.payload });
      if (feedRows.length < 400) feedRows.push({ id: e.id, ts: e.ts.getTime(), type: e.type, objectIds: e.objectIds, author: e.authorLabel, payload: e.payload });
      if (events.length >= 50_000) break;
    }
  const objects = await loadObjects(db, new Set(types.map((x) => x.subject).filter((s): s is string => !!s)));
  const o = operations(events, types.map((x) => x.type), objects, period, now);
  const names = new Map(objects.map((x) => [x.id, x.name]));
  const typeName = (k: string) => nameOf(types.find((x) => x.type === k)?.name, locale, k);
  const color = new Map(types.map((x, i) => [x.type, PALETTE[i % PALETTE.length]]));
  const reg = (k: string) => `/o/${slug}/registers/${k}`;
  const fmt = (v: number, d = 1) => v.toLocaleString(locale, { maximumFractionDigits: d });
  const date = (v: number | null) => (v === null ? "–" : new Date(v).toLocaleDateString(locale, { day: "numeric", month: "short", year: "2-digit" }));
  const f = o.figures;
  const files = uploads.filter((u) => u.createdAt.getTime() >= o.from);
  const rejected = files.reduce((a, u) => a + u.rejectedCount, 0);
  const open = alerts.filter((a) => a.status === "open");
  const alarms = open.filter((a) => a.severity === "alarm").length;
  const used = o.registers.filter((r) => r.n.value || r.n.prev || r.last !== null);
  const harvest = f.yieldKg.value >= 10_000 ? `${fmt(f.yieldKg.value / 1000)} t` : `${fmt(f.yieldKg.value, 0)} kg`;

  const kpis: { k: string; v: string; f?: Figure; sub?: string; href?: string; tone?: string }[] = [
    { k: t.ops_entries, v: fmt(f.entries.value, 0), f: f.entries },
    { k: t.ops_area, v: `${fmt(f.area.value)} ha`, f: f.area, sub: f.hectares ? `${t.db_ofSau} ${fmt(f.hectares)} ha` : undefined },
    { k: t.ops_objects, v: fmt(f.objects.value, 0), f: f.objects },
    { k: t.ops_yield, v: harvest, f: f.yieldKg },
    { k: t.ops_inputs, v: `${fmt(f.liters.value)} L`, sub: `${fmt(f.kilos.value)} kg`, f: f.liters },
    { k: t.db_due, v: String(f.due), sub: t.db_dueHelp, tone: f.due ? "text-warn" : "text-ok", href: "#cycle" },
    { k: t.ops_alerts, v: String(open.length), sub: alarms ? `${alarms} alarm` : undefined, tone: alarms ? "text-alarm" : open.length ? "text-warn" : "text-ok", href: `/o/${slug}/alerts` },
    { k: t.ops_files, v: String(files.length), sub: `${rejected} ${t.ops_rejected}`, tone: rejected ? "text-warn" : undefined, href: `/o/${slug}/upload` },
  ];

  // registrations, files and alerts as one stream, newest first
  type Item = { ts: number; tone: string; title: string; text: string; href: string };
  const feed: Item[] = [
    ...feedRows.filter((e) => e.ts >= o.from).slice(0, 25).map((e) => ({
      ts: e.ts, tone: color.get(e.type) ?? "#9fd8ff", title: typeName(e.type),
      text: [e.objectIds.map((id) => names.get(id)).filter(Boolean).join(", "), typeof e.payload.product === "string" ? e.payload.product : "", e.author ?? ""].filter(Boolean).join(" · "),
      href: reg(e.type),
    })),
    ...files.slice(0, 10).map((u) => ({
      ts: u.createdAt.getTime(), tone: u.rejectedCount ? "#f2b84b" : "#6b7079", title: `${t.ops_file} · ${u.filename ?? "–"}`,
      text: `${u.events} ${t.docEntries.toLowerCase()}${u.rejectedCount ? ` · ${u.rejectedCount} ${t.ops_rejected}` : ""}`, href: `/o/${slug}/upload`,
    })),
    ...alerts.filter((a) => Date.parse(a.openedAt) >= o.from).map((a) => ({
      ts: Date.parse(a.openedAt), tone: a.severity === "alarm" ? "#ff6b6b" : "#f2b84b", title: a.object, text: a.text, href: `/o/${slug}/devices/${a.objectId}`,
    })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 30);

  const say = (s: Signal) => {
    switch (s.kind) {
      case "overdue": return { who: s.name, what: `${s.days} ${t.sig_overdue}`, href: `/o/${slug}/devices/${s.objectId}`, tone: "bg-warn" };
      case "never": return { who: s.name, what: t.sig_never, href: `/o/${slug}/devices/${s.objectId}`, tone: "bg-alarm" };
      case "unharvested": return { who: s.name, what: `${s.days} ${t.sig_unharvested}`, href: `/o/${slug}/devices/${s.objectId}`, tone: "bg-warn" };
      case "drop": return { who: typeName(s.type), what: `${s.value} ${t.sig_drop} ${s.prev}`, href: reg(s.type), tone: "bg-warn" };
      case "silent": return { who: typeName(s.type), what: `${t.sig_silent} ${s.prev}`, href: reg(s.type), tone: "bg-alarm" };
    }
  };
  const signals = [
    ...open.filter((a) => a.severity === "alarm").map((a) => ({ who: a.object, what: a.text, href: `/o/${slug}/devices/${a.objectId}`, tone: "bg-alarm" })),
    ...(rejected ? [{ who: t.ops_files, what: `${rejected} ${t.ops_rejected}`, href: `/o/${slug}/upload`, tone: "bg-warn" }] : []),
    ...o.signals.map(say),
  ];

  const matrixTypes = used.map((r) => r.type).filter((k) => o.matrix.some((m) => m.cells[k]));
  const cellMax = Math.max(1, ...o.matrix.flatMap((m) => Object.values(m.cells)));

  if (!events.length && !alerts.length && !uploads.length)
    return (
      <section className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <p className="text-sm text-mist">{t.ops_noData}</p>
        <div className="flex gap-2">
          {types.slice(0, 3).map((x) => <Link key={x.type} href={`${reg(x.type)}#new`} className={act}>+ {typeName(x.type)}</Link>)}
          <Link href={`/o/${slug}/upload`} className="btn">{t.upload}</Link>
        </div>
      </section>
    );

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4 2xl:grid-cols-8">
        {kpis.map((x) => {
          const body = (
            <>
              <div className={label}>{x.k}</div>
              <div className={`num mt-1.5 text-2xl font-semibold ${x.tone ?? "text-frost"}`}>{x.v}</div>
              <div className="mt-1 flex items-center gap-2">
                {x.f && <Delta f={x.f} />}
                {x.sub && <span className="truncate text-[11px] text-dim">{x.sub}</span>}
                {x.f && x.f.prev !== null && !x.sub && <span className="text-[11px] text-dim">{t.db_vsPrev}</span>}
              </div>
            </>
          );
          return x.href ? (
            <Link key={x.k} href={x.href} className="bg-ink-900 px-4 py-3 hover:bg-ink-800">{body}</Link>
          ) : (
            <div key={x.k} className="bg-ink-900 px-4 py-3">{body}</div>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className={panel}>
          <div className={head}>
            <span className={label}>{t.ops_timeline}</span>
            <span className="num text-[11px] text-dim">{date(o.from)} → {date(o.to - 1)}</span>
          </div>
          <StackChart
            points={o.days}
            series={used.map((r) => ({ key: r.type, label: typeName(r.type), color: color.get(r.type)! }))}
            labels={{ avg: t.db_avg7, total: t.ops_total }}
            locale={locale}
          />
        </div>

        <div className={panel}>
          <div className={head}>
            <span className={label}>{t.ops_signals} · <span className="num">{signals.length}</span></span>
          </div>
          {!signals.length ? (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-mist"><StatusDot status="ok" /> {t.ops_noSignals}</div>
          ) : (
            <ul className="max-h-[400px] divide-y divide-line-soft overflow-y-auto">
              {signals.slice(0, 30).map((s, i) => (
                <li key={i}>
                  <Link href={s.href} className="flex items-start gap-3 px-4 py-2.5 text-sm hover:bg-ink-800">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${s.tone}`} />
                    <span className="min-w-0">
                      <span className="font-medium text-frost">{s.who}</span> <span className="text-mist">— {s.what}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className={panel}>
        <div className={head}><span className={label}>{t.ops_registers} · <span className="num">{types.length}</span></span></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-line-soft text-left text-[11px] uppercase tracking-wider text-dim">
              <tr>
                <th className="px-4 py-2 font-medium">{t.db_register}</th>
                <th className="px-3 py-2 text-right font-medium">{t.ops_entries}</th>
                <th className="px-3 py-2 font-medium" />
                <th className="px-3 py-2 text-right font-medium">ha</th>
                <th className="px-3 py-2 text-right font-medium">{t.ops_objects}</th>
                <th className="px-3 py-2 font-medium">{t.db_trend}</th>
                <th className="px-3 py-2 font-medium">{t.ops_last}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {o.registers.map((r) => (
                <tr key={r.type} className={`hover:bg-ink-800/60 ${r.last === null ? "opacity-50" : ""}`}>
                  <td className="px-4 py-2">
                    <Link href={reg(r.type)} className="flex items-center gap-2 text-frost hover:text-ice">
                      <span className="h-2 w-2 rounded-sm" style={{ background: color.get(r.type) }} />{typeName(r.type)}
                    </Link>
                  </td>
                  <td className="num px-3 py-2 text-right text-frost">{r.n.value}</td>
                  <td className="px-3 py-2"><Delta f={r.n} /></td>
                  <td className="num px-3 py-2 text-right text-mist">{r.ha ? fmt(r.ha) : "–"}</td>
                  <td className="num px-3 py-2 text-right text-mist">{r.objects || "–"}</td>
                  <td className="px-3 py-2"><Spark values={r.spark} tone={color.get(r.type)!} /></td>
                  <td className="num px-3 py-2 text-xs text-mist">{r.last === null ? t.db_never : timeAgo(new Date(r.last).toISOString(), locale, t)}</td>
                  <td className="px-4 py-2 text-right"><Link href={`${reg(r.type)}#new`} className={act}>+ {t.ops_new}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4 min-w-0">
          {o.cycles.length > 0 && (
            <div id="cycle" className={`${panel} scroll-mt-24`}>
              <div className={head}>
                <span className={label}>{t.ops_cycle} · <span className="num">{o.cycles.length}</span></span>
                <span className="num text-[11px] text-dim">{fmt(f.hectares)} ha</span>
              </div>
              <div className="max-h-[520px] overflow-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead className="sticky top-0 border-b border-line-soft bg-ink-900 text-left text-[11px] uppercase tracking-wider text-dim">
                    <tr>
                      <th className="px-4 py-2 font-medium">{t.db_crop}</th>
                      <th className="px-3 py-2 text-right font-medium">ha</th>
                      <th className="px-3 py-2 font-medium">{t.ops_sown}</th>
                      <th className="px-3 py-2 font-medium">{t.ops_treated}</th>
                      <th className="px-3 py-2 text-right font-medium">{t.treatments}</th>
                      <th className="px-3 py-2 font-medium">{t.ops_harvested}</th>
                      <th className="px-3 py-2 text-right font-medium">{t.ops_yield}</th>
                      <th className="px-3 py-2 text-right font-medium">{t.ops_yieldHa}</th>
                      <th className="px-4 py-2 text-right font-medium">{t.ops_idle}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {o.cycles.map((c) => (
                      <tr key={c.id} className="hover:bg-ink-800/60">
                        <td className="px-4 py-2">
                          <Link href={`/o/${slug}/devices/${c.id}`} className="flex items-center gap-2 text-frost hover:text-ice">
                            <StatusDot status={c.status === "ok" ? "ok" : c.status === "due" ? "warn" : "alarm"} />{c.name}
                          </Link>
                        </td>
                        <td className="num px-3 py-2 text-right text-mist">{c.hectares === null ? "–" : fmt(c.hectares)}</td>
                        <td className="num px-3 py-2 text-xs text-mist">{date(c.sown)}</td>
                        <td className={`num px-3 py-2 text-xs ${c.status === "ok" ? "text-mist" : "text-warn"}`}>{c.treated === null ? t.db_never : date(c.treated)}</td>
                        <td className="num px-3 py-2 text-right text-frost">{c.treatments || "–"}</td>
                        <td className="num px-3 py-2 text-xs text-mist">{date(c.harvested)}</td>
                        <td className="num px-3 py-2 text-right text-frost">{c.yieldKg ? `${fmt(c.yieldKg, 0)} kg` : "–"}</td>
                        <td className="num px-3 py-2 text-right text-ice">{c.yieldHa === null ? "–" : `${fmt(c.yieldHa / 1000, 2)} t`}</td>
                        <td className="num px-4 py-2 text-right text-xs text-dim">{c.idle === null ? "–" : `${c.idle}${t.ov_days}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {o.matrix.length > 0 && matrixTypes.length > 0 && (
            <div className={panel}>
              <div className={head}><span className={label}>{t.ops_matrix}</span></div>
              <div className="overflow-x-auto p-4">
                <table className="w-full min-w-[520px] border-separate border-spacing-[3px] text-xs">
                  <thead>
                    <tr>
                      <th />
                      {matrixTypes.map((k) => <th key={k} className="truncate px-1 pb-1 text-left font-normal text-dim">{typeName(k)}</th>)}
                      <th className="px-1 pb-1 text-right font-normal text-dim">Σ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.matrix.map((m) => (
                      <tr key={m.id}>
                        <td className="max-w-[160px] truncate pr-2 text-mist">
                          <Link href={`/o/${slug}/devices/${m.id}`} className="hover:text-frost">{m.name}</Link>
                        </td>
                        {matrixTypes.map((k) => {
                          const v = m.cells[k] ?? 0;
                          return (
                            <td key={k} title={`${m.name} · ${typeName(k)}: ${v}`} className="num h-7 rounded-sm text-center text-[11px]"
                              style={{ background: v ? color.get(k) : "#111317", opacity: v ? 0.25 + 0.75 * (v / cellMax) : 1, color: v ? "#07080a" : "transparent" }}>
                              {v || ""}
                            </td>
                          );
                        })}
                        <td className="num pl-2 text-right text-frost">{m.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className={panel}>
          <div className={head}><span className={label}>{t.ops_feed}</span><StatusDot status="ok" pulse /></div>
          <ul className="max-h-[760px] divide-y divide-line-soft overflow-y-auto">
            {feed.map((x, i) => (
              <li key={i}>
                <Link href={x.href} className="flex items-start gap-3 px-4 py-2.5 hover:bg-ink-800">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-sm" style={{ background: x.tone }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-frost">{x.title}</span>
                    <span className="block truncate text-xs text-mist">{x.text || "–"}</span>
                  </span>
                  <span className="num shrink-0 text-[11px] text-dim">{timeAgo(new Date(x.ts).toISOString(), locale, t)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
