import Link from "next/link";
import { tenantDb } from "@/lib/engine/db";
import { listCrops, listTreatments } from "@/lib/packages/agronomy/console";
import type { RegisterRow } from "@/lib/packages/agronomy/register";
import { dashboard, periodFrom, type Figure, type Mix } from "@/lib/packages/agronomy/dashboard";
import { analyze } from "@/lib/packages/records/analysis";
import type { RecordEntry } from "@/lib/packages/records/console";
import type { Locale } from "@/lib/packages/types";
import type { Dict } from "@/lib/i18n";
import { OpsChart } from "@/components/terra/chart";
import { Heatmap, Signals } from "@/components/terra/modules/records/analysis";
import { TreatmentRows } from "./rows";

const asEntry = (r: RegisterRow): RecordEntry => {
  const area = r.areaHa ?? 0;
  const quantity = r.quantity?.value ?? 0;
  return {
    id: String(r.id),
    ts: r.date,
    objectId: r.cropId ?? "",
    subject: r.crop,
    payload: { product: r.product, area, quantity, dose: area > 0 ? Math.round((quantity / area) * 100) / 100 : 0 },
  };
};

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

function Spark({ values, tone = "#9fd8ff" }: { values: number[]; tone?: string }) {
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

function MixPanel({ title, items, href, locale }: { title: string; items: Mix[]; href: (k: string) => string; locale: Locale }) {
  const max = Math.max(1, ...items.map((i) => i.n));
  return (
    <div className={panel}>
      <div className={head}><span className={label}>{title}</span></div>
      <ul className="divide-y divide-line-soft">
        {items.map((m) => (
          <li key={m.key}>
            <Link href={href(m.key)} className="group block px-4 py-2 hover:bg-ink-800">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate text-frost">{m.key}</span>
                <span className="num shrink-0 text-xs text-mist">
                  {m.n}×{m.L ? ` · ${m.L.toLocaleString(locale)} L` : ""}{m.kg ? ` · ${m.kg.toLocaleString(locale)} kg` : ""}
                </span>
              </div>
              <div className="mt-1.5 h-1 rounded-full bg-ink-800">
                <div className="h-1 rounded-full bg-ice/70 group-hover:bg-ice" style={{ width: `${(m.n / max) * 100}%` }} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export async function AgronomyOverview({ orgId, slug, t, locale, period }: { orgId: string; slug: string; t: Dict; locale: Locale; period?: number }) {
  const db = tenantDb(orgId);
  const crops = await listCrops(db);
  const rows = await listTreatments(db, {}, crops);
  const d = dashboard(rows, crops, periodFrom(period));
  const inside = rows.filter((r) => { const x = Date.parse(r.date); return x >= d.from && x < d.to; });
  const a = analyze(inside.map(asEntry));
  const reg = `/terra/o/${slug}/registers/agronomy.treatment`;
  const range = `from=${new Date(d.from).toISOString().slice(0, 10)}&to=${new Date(d.to - 1).toISOString().slice(0, 10)}`;
  const fmt = (v: number) => v.toLocaleString(locale, { maximumFractionDigits: 1 });
  const f = d.figures;

  if (!crops.length)
    return (
      <section className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <p className="text-sm text-mist">{t.noCrops}</p>
        <Link href={`/terra/o/${slug}/upload`} className="btn">{t.upload}</Link>
      </section>
    );

  const kpis: { k: string; v: string; f?: Figure; sub?: string; href?: string; tone?: string }[] = [
    { k: t.treatments, v: fmt(f.treatments.value), f: f.treatments, href: `${reg}?${range}` },
    { k: t.an_area, v: `${fmt(f.area.value)} ha`, f: f.area, sub: f.hectares ? `${Math.round((f.area.value / f.hectares) * 100)}% ${t.db_ofSau}` : undefined },
    { k: t.db_liters, v: `${fmt(f.liters.value)} L`, f: f.liters },
    { k: t.db_kilos, v: `${fmt(f.kilos.value)} kg`, f: f.kilos },
    { k: t.db_activeCrops, v: `${f.active.value}/${d.crops.length}`, f: f.active },
    { k: t.db_due, v: String(f.due), sub: t.db_dueHelp, tone: f.due ? "text-warn" : "text-ok", href: "#crops" },
  ];

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 xl:grid-cols-6">
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

      <div className="grid gap-4 xl:grid-cols-3">
        <div className={`${panel} xl:col-span-2`}>
          <div className={head}>
            <span className={label}>{t.db_ops}</span>
            <span className="num text-[11px] text-dim">
              {new Date(d.from).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })} → {new Date(d.to - 1).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })}
            </span>
          </div>
          <OpsChart
            points={d.days}
            locale={locale}
            labels={{ n: t.treatments, ha: "ha", L: "L", kg: "kg", avg: t.db_avg7, mean: t.db_mean }}
          />
        </div>
        <div className={panel}>
          <div className={head}>
            <span className={label}>{t.an_signals}</span>
            <span className="num text-[11px] text-dim">{a.signals.length}</span>
          </div>
          <div className="max-h-[360px] overflow-y-auto [&>.card]:rounded-none [&>.card]:border-0">
            <Signals a={a} slug={slug} t={t} locale={locale} limit={12} />
          </div>
        </div>
      </div>

      <div id="crops" className={panel}>
        <div className={head}>
          <span className={label}>{t.crops} · <span className="num">{d.crops.length}</span></span>
          <div className="flex gap-3 text-[11px]">
            <span className="flex items-center gap-1.5 text-mist"><i className="h-1.5 w-1.5 rounded-full bg-ok" />≤ 21{t.ov_days}</span>
            <span className="flex items-center gap-1.5 text-mist"><i className="h-1.5 w-1.5 rounded-full bg-warn" />{t.db_overdue}</span>
            <span className="flex items-center gap-1.5 text-mist"><i className="h-1.5 w-1.5 rounded-full bg-dim" />{t.db_never}</span>
          </div>
        </div>
        <div className="max-h-[440px] overflow-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="sticky top-0 bg-ink-900 text-left text-[11px] uppercase tracking-wider text-dim">
              <tr className="border-b border-line-soft">
                <th className="px-4 py-2 font-medium">{t.db_crop}</th>
                <th className="px-3 py-2 text-right font-medium">ha</th>
                <th className="px-3 py-2 font-medium">{t.db_phase}</th>
                <th className="px-3 py-2 text-right font-medium">{t.db_since}</th>
                <th className="px-3 py-2 text-right font-medium">{t.treatments}</th>
                <th className="px-3 py-2 text-right font-medium">{t.db_haWorked}</th>
                <th className="px-3 py-2 font-medium">{t.db_trend}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {d.crops.map((c) => (
                <tr key={c.id} className="hover:bg-ink-800/60">
                  <td className="px-4 py-2">
                    <Link href={`/terra/o/${slug}/devices/${c.id}`} className="flex items-center gap-2.5 text-frost hover:underline">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.status === "ok" ? "bg-ok" : c.status === "due" ? "bg-warn" : "bg-dim"}`} />
                      <span className="truncate">{c.name}</span>
                    </Link>
                  </td>
                  <td className="num px-3 py-2 text-right text-mist">{c.hectares ?? "–"}</td>
                  <td className="px-3 py-2 text-xs text-mist">{c.phase ?? "–"}</td>
                  <td className={`num px-3 py-2 text-right ${c.status === "due" ? "text-warn" : "text-mist"}`}>
                    {c.days === null ? "–" : `${c.days}${t.ov_days}`}
                  </td>
                  <td className="num px-3 py-2 text-right text-frost">{c.inPeriod || <span className="text-dim">0</span>}</td>
                  <td className="num px-3 py-2 text-right text-mist">{c.ha ? fmt(c.ha) : "–"}</td>
                  <td className="px-3 py-2"><Spark values={c.spark} tone={c.status === "due" ? "#f2b84b" : "#9fd8ff"} /></td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1.5">
                      <Link href={`${reg}?obj=${c.id}#new`} className={act}>+ {t.db_treat}</Link>
                      <Link href={`${reg}?obj=${c.id}&${range}`} className={act}>{t.db_register}</Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {inside.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <MixPanel title={t.an_byProduct} items={d.products} locale={locale} href={(k) => `${reg}?${range}&f.product=${encodeURIComponent(k)}`} />
          <MixPanel title={t.db_byAdversity} items={d.adversities} locale={locale} href={(k) => `${reg}?${range}&f.adversity=${encodeURIComponent(k)}`} />
        </div>
      )}

      {a.matrix.length > 1 && a.weeks.length > 1 && (
        <div className={panel}>
          <div className={head}><span className={label}>{t.an_heat}</span></div>
          <div className="p-3 [&>.card]:border-0"><Heatmap a={a} slug={slug} t={t} locale={locale} /></div>
        </div>
      )}

      <div className={panel}>
        <div className={head}>
          <span className={label}>{t.recordsLatest}</span>
          <Link href={`${reg}?${range}`} className="text-xs text-mist hover:text-frost">{t.treatmentsRegister} →</Link>
        </div>
        <div className="[&>*]:rounded-none [&>*]:border-0">
          <TreatmentRows rows={inside.slice(0, 10)} locale={locale} t={t} />
        </div>
      </div>
    </section>
  );
}
