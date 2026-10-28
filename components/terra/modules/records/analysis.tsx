import Link from "next/link";
import type { Analysis, Signal } from "@/lib/packages/records/analysis";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";
import { DoseScatter, Pareto, Spark, WeekBars } from "@/components/terra/chart";

const PALETTE = ["#9fd8ff", "#3ddc84", "#f2b84b", "#c792ea", "#ff8a65", "#6b7079"];

const n = (v: number, locale: Locale, d = 1) => v.toLocaleString(locale, { maximumFractionDigits: d });
const day = (ts: string, locale: Locale) => new Date(ts).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });

function Kpi({ label, value, sub, spark, color }: { label: string; value: string; sub?: string; spark?: number[]; color?: string }) {
  return (
    <div className="card flex flex-col p-4">
      <div className="text-xs uppercase tracking-wider text-dim">{label}</div>
      <div className="num mt-1 text-2xl font-semibold text-frost">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-mist">{sub}</div>}
      {spark && <div className="mt-auto pt-2"><Spark values={spark} color={color} /></div>}
    </div>
  );
}

const total = (w: Record<string, number>) => Object.entries(w).reduce((a, [k, v]) => (k === "t" || k.startsWith("_") ? a : a + v), 0);

export function Kpis({ a, t, locale }: { a: Analysis; t: Dict; locale: Locale }) {
  const { totals } = a;
  const perWeek = a.weeks.map(total);
  const active = a.bySubject.filter((s) => Date.parse(s.last) > Date.parse(totals.last ?? "") - 30 * 86400000).length;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Kpi label={t.an_entries} value={n(totals.entries, locale)} spark={perWeek}
        sub={totals.first && totals.last ? `${day(totals.first, locale)} → ${day(totals.last, locale)}` : undefined} />
      <Kpi label={t.an_subjects} value={n(totals.subjects, locale)} sub={`${n(active, locale)} ${t.an_active30}`} />
      <Kpi label={t.an_products} value={n(totals.products, locale)}
        sub={a.byProduct[0] ? `${a.byProduct[0].key} ${n((a.byProduct[0].entries / totals.entries) * 100, locale, 0)}%` : undefined} />
      <Kpi label={t.an_area} value={`${n(totals.area, locale)} ha`} spark={a.weeks.map((w) => w._cum ?? 0)} color="#e8ecf1"
        sub={totals.quantity ? `${t.rec_quantity}: ${n(totals.quantity, locale)}` : undefined} />
    </div>
  );
}

export function Weeks({ a, t, locale }: { a: Analysis; t: Dict; locale: Locale }) {
  if (a.weeks.length < 2) return null;
  return (
    <div className="card p-4">
      <WeekBars rows={a.weeks} series={series(a, t)} locale={locale} cumLabel={a.totals.area ? t.an_cumArea : undefined} />
    </div>
  );
}

const series = (a: Analysis, t: Dict) =>
  (a.products.length ? a.products : ["other"]).map((k, i) => ({
    key: k, label: k === "other" ? t.an_other : k, color: k === "other" ? PALETTE[5] : PALETTE[i % 5],
  }));

export function Heatmap({ a, slug, t, locale }: { a: Analysis; slug: string; t: Dict; locale: Locale }) {
  if (a.weeks.length < 2 || !a.matrix.length) return null;
  const max = Math.max(1, ...a.matrix.flatMap((m) => m.cells));
  const cols = { gridTemplateColumns: `repeat(${a.weeks.length}, minmax(0, 1fr))` };
  const wk = (i: number) => new Date(a.weeks[i].t).toLocaleDateString(locale, { day: "numeric", month: "short" });
  const months = a.weeks.map((w, i) => {
    const d = new Date(w.t);
    return i === 0 || d.getUTCMonth() !== new Date(a.weeks[i - 1].t).getUTCMonth() ? d.toLocaleDateString(locale, { month: "short" }) : "";
  });
  return (
    <div className="card overflow-x-auto p-4">
      <div className="min-w-[480px] space-y-[3px]">
        {a.matrix.map((m) => (
          <div key={m.key} className="flex items-center gap-3">
            <Link href={`/terra/o/${slug}/devices/${m.objectId}`} className="w-36 shrink-0 truncate text-xs text-mist hover:text-ice">{m.key}</Link>
            <div className="grid flex-1 gap-[3px]" style={cols}>
              {m.cells.map((c, i) => (
                <div key={i} title={`${m.key} · ${wk(i)} · ${c}`} className="h-4 rounded-[2px]"
                  style={{ background: c ? `rgba(159,216,255,${0.18 + 0.82 * (c / max)})` : "#16191d" }} />
              ))}
            </div>
          </div>
        ))}
        <div className="flex gap-3 pt-1">
          <div className="w-36 shrink-0" />
          <div className="grid flex-1 gap-[3px] text-[10px] text-dim" style={cols}>
            {months.map((m, i) => <div key={i} className="overflow-visible whitespace-nowrap">{m}</div>)}
          </div>
        </div>
      </div>
      {a.bySubject.length > a.matrix.length && <div className="mt-3 text-xs text-dim">+{a.bySubject.length - a.matrix.length} {t.an_more}</div>}
    </div>
  );
}

export function Doses({ a, t, locale }: { a: Analysis; t: Dict; locale: Locale }) {
  if (a.doses.length < 3) return null;
  const s = series(a, t).filter((x) => a.doses.some((d) => d.product === x.key));
  return (
    <div className="card p-4">
      <DoseScatter points={a.doses} series={s} locale={locale} />
    </div>
  );
}

export function Shares({ a, slug, t, locale }: { a: Analysis; slug: string; t: Dict; locale: Locale }) {
  const top = a.bySubject.length > 1 ? a.bySubject.slice(0, 10) : [];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {a.byProduct.length > 1 && (
        <div>
          <div className="mb-2 text-xs uppercase tracking-wider text-dim">{t.an_byProduct}</div>
          <div className="card p-4">
            <Pareto rows={a.byProduct.slice(0, 15).map((p) => ({ key: p.key, value: p.entries }))} locale={locale} label={t.an_entries} />
          </div>
        </div>
      )}
      {top.length > 0 && <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-dim">{t.an_bySubject}</div>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-dim">
              <tr>
                <th className="px-4 py-2 font-normal" />
                <th className="px-2 py-2 text-right font-normal">{t.an_entries}</th>
                <th className="px-2 py-2 font-normal">%</th>
                <th className="px-2 py-2 text-right font-normal">ha</th>
                <th className="px-4 py-2 text-right font-normal">{t.an_last}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {top.map((r) => {
                const pct = (r.entries / Math.max(1, a.totals.entries)) * 100;
                return (
                  <tr key={r.key}>
                    <td className="max-w-[12rem] truncate px-4 py-2"><Link href={`/terra/o/${slug}/devices/${r.objectId}`} className="text-frost hover:text-ice">{r.key}</Link></td>
                    <td className="num px-2 py-2 text-right text-frost">{n(r.entries, locale)}</td>
                    <td className="w-28 px-2 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-sm bg-line-soft"><div className="h-1.5 rounded-sm bg-ice" style={{ width: `${pct}%` }} /></div>
                        <span className="num w-8 text-right text-xs text-mist">{n(pct, locale, 0)}</span>
                      </div>
                    </td>
                    <td className="num px-2 py-2 text-right text-mist">{r.area ? n(r.area, locale) : "—"}</td>
                    <td className="num whitespace-nowrap px-4 py-2 text-right text-mist">{day(r.last, locale)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {a.bySubject.length > top.length && <div className="border-t border-line-soft px-4 py-2 text-xs text-dim">+{a.bySubject.length - top.length} {t.an_more}</div>}
        </div>
      </div>}
    </div>
  );
}

function say(s: Signal, t: Dict, locale: Locale): string {
  const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
  switch (s.kind) {
    case "idle":
      return fill(t.an_sig_idle, { days: String(s.days), usual: String(s.usual) });
    case "dose":
      return fill(t.an_sig_dose, { product: s.product, dose: n(s.dose, locale, 2), usual: n(s.usual, locale, 2), date: day(s.ts, locale) });
    case "twice":
      return fill(t.an_sig_twice, { product: s.product, date: day(s.ts, locale) });
  }
}

export function Signals({ a, slug, t, locale, limit = 8 }: { a: Analysis; slug: string; t: Dict; locale: Locale; limit?: number }) {
  return (
    <div className="card divide-y divide-line-soft">
      {a.signals.length === 0 && <div className="p-4 text-sm text-mist">{t.an_noSignals}</div>}
      {a.signals.slice(0, limit).map((s, i) => (
        <Link key={i} href={`/terra/o/${slug}/devices/${s.objectId}`} className="flex items-start gap-3 p-4 text-sm hover:bg-ink-800">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${s.kind === "idle" ? "bg-warn" : "bg-alarm"}`} />
          <span>
            <span className="font-medium text-frost">{s.subject}</span> <span className="text-mist">— {say(s, t, locale)}</span>
          </span>
        </Link>
      ))}
      {a.signals.length > limit && <div className="p-3 text-xs text-dim">+{a.signals.length - limit} {t.an_more}</div>}
    </div>
  );
}

