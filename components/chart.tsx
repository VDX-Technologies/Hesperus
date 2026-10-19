"use client";
import { useState } from "react";
import {
  Area, AreaChart, Bar, Brush, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from "recharts";

export interface Series {
  key: string;
  label: string;
  color: string;
  axis?: "left" | "right";
  dashed?: boolean;
}

/** Time-series chart in the VDX style. rows: [{ t: epoch ms, <key>: number|null }] */
export function TimeChart({
  rows,
  series,
  locale,
  unitLeft,
  unitRight,
  height = 240,
}: {
  rows: Record<string, number | null>[];
  series: Series[];
  locale: string;
  unitLeft?: string;
  unitRight?: string;
  height?: number;
}) {
  const span = rows.length ? (rows[rows.length - 1].t as number) - (rows[0].t as number) : 0;
  const tick = (v: number) =>
    new Date(v).toLocaleString(locale, span > 2 * 86400000 ? { weekday: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" });
  const hasRight = series.some((s) => s.axis === "right");
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <CartesianGrid stroke="#16191d" vertical={false} />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={tick} stroke="#6b7079" fontSize={11} tickLine={false} minTickGap={40} />
        <YAxis yAxisId="left" stroke="#6b7079" fontSize={11} tickLine={false} axisLine={false} unit={unitLeft} width={52} />
        {hasRight && <YAxis yAxisId="right" orientation="right" stroke="#6b7079" fontSize={11} tickLine={false} axisLine={false} unit={unitRight} width={52} />}
        <Tooltip
          contentStyle={{ background: "#111317", border: "1px solid #23282f", borderRadius: 8, fontSize: 12 }}
          labelFormatter={(v) => new Date(v as number).toLocaleString(locale)}
          formatter={(v) => (typeof v === "number" ? v.toLocaleString(locale, { maximumFractionDigits: 2 }) : v)}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: "#a3a9b2" }} iconType="plainline" />
        {series.map((s) => (
          <Line
            key={s.key}
            yAxisId={s.axis ?? "left"}
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={1.6}
            strokeDasharray={s.dashed ? "4 3" : undefined}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

const TOOLTIP = { background: "#111317", border: "1px solid #23282f", borderRadius: 8, fontSize: 12 };

const AXIS = { stroke: "#6b7079", fontSize: 11, tickLine: false } as const;

/** Stacked weekly entries per product, with the running total of area worked as a line on the right axis. */
export function WeekBars({
  rows, series, locale, cumLabel, height = 280,
}: { rows: Record<string, number>[]; series: Series[]; locale: string; cumLabel?: string; height?: number }) {
  const day = (v: number) => new Date(v).toLocaleDateString(locale, { day: "numeric", month: "short" });
  const cum = !!cumLabel && rows.some((r) => r._cum);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: cum ? 0 : 8, bottom: 0, left: -20 }}>
        <CartesianGrid stroke="#16191d" vertical={false} />
        <XAxis dataKey="t" tickFormatter={day} {...AXIS} minTickGap={24} />
        <YAxis yAxisId="n" {...AXIS} axisLine={false} allowDecimals={false} />
        {cum && <YAxis yAxisId="cum" orientation="right" {...AXIS} axisLine={false} unit=" ha" width={56} />}
        <Tooltip
          contentStyle={TOOLTIP}
          cursor={{ fill: "#16191d" }}
          labelFormatter={(v) => `${day(v as number)} → ${day((v as number) + 6 * 86400000)}`}
          formatter={(v) => (typeof v === "number" ? v.toLocaleString(locale, { maximumFractionDigits: 2 }) : v)}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: "#a3a9b2" }} iconType="square" />
        {series.map((s, i) => (
          <Bar key={s.key} yAxisId="n" dataKey={s.key} name={s.label} stackId="a" fill={s.color} fillOpacity={0.85}
            radius={i === series.length - 1 ? [2, 2, 0, 0] : undefined} isAnimationActive={false} />
        ))}
        {cum && (
          <Area yAxisId="cum" type="monotone" dataKey="_cum" name={cumLabel} stroke="#e8ecf1" strokeWidth={1.5}
            fill="#e8ecf1" fillOpacity={0.06} dot={false} isAnimationActive={false} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export interface DosePoint { t: number; dose: number; product: string; subject: string; odd: boolean }

/** Every dose over time, one colour per product; doses out of line are ringed in red. */
export function DoseScatter({ points, series, locale, height = 280 }: { points: DosePoint[]; series: Series[]; locale: string; height?: number }) {
  const day = (v: number) => new Date(v).toLocaleDateString(locale, { day: "numeric", month: "short" });
  const Dot = (p: { cx?: number; cy?: number; payload?: DosePoint; fill?: string }) =>
    p.payload?.odd ? (
      <g>
        <circle cx={p.cx} cy={p.cy} r={7} fill="none" stroke="#ff5a5f" strokeWidth={1.5} />
        <circle cx={p.cx} cy={p.cy} r={3.5} fill="#ff5a5f" />
      </g>
    ) : (
      <circle cx={p.cx} cy={p.cy} r={3.5} fill={p.fill} fillOpacity={0.8} />
    );
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
        <CartesianGrid stroke="#16191d" />
        <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={day} {...AXIS} minTickGap={32} />
        <YAxis dataKey="dose" type="number" {...AXIS} axisLine={false} />
        <ZAxis range={[40, 40]} />
        <Tooltip
          contentStyle={TOOLTIP}
          cursor={{ stroke: "#23282f" }}
          content={({ payload }) => {
            const d = payload?.[0]?.payload as DosePoint | undefined;
            if (!d) return null;
            return (
              <div style={TOOLTIP} className="px-3 py-2">
                <div className="text-frost">{d.subject}</div>
                <div className="text-mist">{d.product} · <span className={d.odd ? "text-alarm" : "text-frost"}>{d.dose.toLocaleString(locale)}</span></div>
                <div className="text-dim">{new Date(d.t).toLocaleDateString(locale)}</div>
              </div>
            );
          }}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: "#a3a9b2" }} iconType="circle" />
        {series.map((s) => (
          <Scatter key={s.key} name={s.label} data={points.filter((p) => p.product === s.key)} fill={s.color} shape={Dot} isAnimationActive={false} />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/** Pareto: entries per item, largest first, with the cumulative share on the right axis. */
export function Pareto({ rows, locale, label, height = 260 }: { rows: { key: string; value: number }[]; locale: string; label: string; height?: number }) {
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  const data = rows.map((r, i) => ({ ...r, cum: Math.round((rows.slice(0, i + 1).reduce((a, x) => a + x.value, 0) / total) * 1000) / 10 }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: -20 }}>
        <CartesianGrid stroke="#16191d" vertical={false} />
        <XAxis dataKey="key" {...AXIS} interval={0} angle={-30} textAnchor="end" height={56} tickFormatter={(v: string) => (v.length > 14 ? v.slice(0, 13) + "…" : v)} />
        <YAxis yAxisId="n" {...AXIS} axisLine={false} allowDecimals={false} />
        <YAxis yAxisId="p" orientation="right" {...AXIS} axisLine={false} domain={[0, 100]} unit="%" width={44} />
        <Tooltip contentStyle={TOOLTIP} cursor={{ fill: "#16191d" }} formatter={(v) => (typeof v === "number" ? v.toLocaleString(locale) : v)} />
        <ReferenceLine yAxisId="p" y={80} stroke="#f2b84b" strokeDasharray="4 3" />
        <Bar yAxisId="n" dataKey="value" name={label} fill="#9fd8ff" fillOpacity={0.8} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        <Line yAxisId="p" dataKey="cum" name="%" stroke="#f2b84b" strokeWidth={1.5} dot={{ r: 2 }} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Tiny line for a KPI card. */
export function Spark({ values, color = "#9fd8ff", height = 32 }: { values: number[]; color?: string; height?: number }) {
  if (values.length < 2) return null;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={values.map((v, i) => ({ i, v }))} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.2} fill={color} fillOpacity={0.12} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export interface OpsPoint { t: number; n: number; ha: number; L: number; kg: number; avg: number }
export type OpsMetric = "n" | "ha" | "L" | "kg";

/**
 * The operations timeline: one bar per day for the chosen measure, the weekly trend over it,
 * a brush to zoom into any stretch, and the period's mean as a reference. The measure is picked
 * from the tabs above it; a tab with nothing to show is left out.
 */
export function OpsChart({
  points, labels, locale, height = 300,
}: { points: OpsPoint[]; labels: Record<OpsMetric | "avg" | "mean", string>; locale: string; height?: number }) {
  const metrics = (["n", "ha", "L", "kg"] as const).filter((m) => m === "n" || points.some((p) => p[m] > 0));
  const [metric, setMetric] = useState<OpsMetric>("n");
  const values = points.map((p) => p[metric]);
  const total = values.reduce((a, b) => a + b, 0);
  const active = values.filter((v) => v > 0).length;
  const mean = active ? total / points.length : 0;
  const peak = Math.max(0, ...values);
  const long = points.length > 120;
  const day = (v: number) => new Date(v).toLocaleDateString(locale, long ? { month: "short", year: "2-digit" } : { day: "numeric", month: "short" });
  const fmtN = (v: number) => v.toLocaleString(locale, { maximumFractionDigits: 2 });
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
        <div role="tablist" className="flex gap-1 rounded-md border border-line-soft bg-ink-900 p-0.5">
          {metrics.map((m) => (
            <button key={m} role="tab" aria-selected={metric === m} onClick={() => setMetric(m)}
              className={`rounded px-2.5 py-1 text-xs transition-colors ${metric === m ? "bg-steel text-frost" : "text-dim hover:text-mist"}`}>
              {labels[m]}
            </button>
          ))}
        </div>
        <dl className="num flex gap-5 text-xs">
          <div><dt className="inline text-dim">Σ </dt><dd className="inline text-frost">{fmtN(total)}</dd></div>
          <div><dt className="inline text-dim">{labels.mean} </dt><dd className="inline text-frost">{fmtN(mean)}</dd></div>
          <div><dt className="inline text-dim">max </dt><dd className="inline text-frost">{fmtN(peak)}</dd></div>
        </dl>
      </div>
      <div className="px-2 pt-3">
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={points} margin={{ top: 4, right: 12, bottom: 0, left: -14 }} barCategoryGap={1}>
            <defs>
              <linearGradient id="ops-bar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#9fd8ff" stopOpacity={0.95} />
                <stop offset="100%" stopColor="#9fd8ff" stopOpacity={0.35} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#16191d" vertical={false} />
            <XAxis dataKey="t" tickFormatter={day} {...AXIS} minTickGap={36} />
            <YAxis {...AXIS} axisLine={false} allowDecimals={metric !== "n"} width={48} />
            <Tooltip
              cursor={{ fill: "#9fd8ff", fillOpacity: 0.06 }}
              content={({ payload, label }) => {
                const p = payload?.[0]?.payload as OpsPoint | undefined;
                if (!p) return null;
                return (
                  <div style={TOOLTIP} className="min-w-44 px-3 py-2">
                    <div className="mb-1 text-dim">{new Date(label as number).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</div>
                    {metrics.map((m) => (
                      <div key={m} className="flex justify-between gap-4">
                        <span className={m === metric ? "text-frost" : "text-mist"}>{labels[m]}</span>
                        <span className="num text-frost">{fmtN(p[m])}</span>
                      </div>
                    ))}
                    <div className="mt-1 flex justify-between gap-4 border-t border-line pt-1">
                      <span className="text-warn">{labels.avg}</span>
                      <span className="num text-frost">{fmtN(p.avg)}</span>
                    </div>
                  </div>
                );
              }}
            />
            {mean > 0 && <ReferenceLine y={mean} stroke="#6b7079" strokeDasharray="3 4" label={{ value: labels.mean, position: "insideTopRight", fill: "#6b7079", fontSize: 10 }} />}
            <Bar dataKey={metric} fill="url(#ops-bar)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
            {metric === "n" && <Line dataKey="avg" stroke="#f2b84b" strokeWidth={1.6} dot={false} type="monotone" isAnimationActive={false} />}
            {points.length > 14 && (
              <Brush dataKey="t" height={26} travellerWidth={8} stroke="#23282f" fill="#07080a" tickFormatter={day}>
                <AreaChart data={points}>
                  <Area dataKey={metric} stroke="#9fd8ff" fill="#9fd8ff" fillOpacity={0.15} dot={false} isAnimationActive={false} />
                </AreaChart>
              </Brush>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export interface StackSeries { key: string; label: string; color: string }

/**
 * Every register on one timeline: a bar per day stacked by register, the weekly trend of all of
 * them over it and a brush to zoom. A register is hidden or shown from its chip in the legend.
 */
export function StackChart({
  points, series, labels, locale, height = 320,
}: { points: Record<string, number>[]; series: StackSeries[]; labels: { avg: string; total: string }; locale: string; height?: number }) {
  const [off, setOff] = useState<Set<string>>(new Set());
  const shown = series.filter((s) => !off.has(s.key));
  const long = points.length > 120;
  const day = (v: number) => new Date(v).toLocaleDateString(locale, long ? { month: "short", year: "2-digit" } : { day: "numeric", month: "short" });
  const totals = Object.fromEntries(series.map((s) => [s.key, points.reduce((a, p) => a + (p[s.key] ?? 0), 0)]));
  const toggle = (k: string) => setOff((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 border-b border-line-soft px-4 py-2.5">
        {series.map((s) => (
          <button key={s.key} onClick={() => toggle(s.key)} aria-pressed={!off.has(s.key)}
            className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] transition-opacity ${off.has(s.key) ? "border-line-soft text-dim opacity-50" : "border-line text-mist"}`}>
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.label} <span className="num text-frost">{totals[s.key]}</span>
          </button>
        ))}
      </div>
      <div className="px-2 pt-3">
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={points} margin={{ top: 4, right: 12, bottom: 0, left: -14 }} barCategoryGap={1}>
            <CartesianGrid stroke="#16191d" vertical={false} />
            <XAxis dataKey="t" tickFormatter={day} {...AXIS} minTickGap={36} />
            <YAxis {...AXIS} axisLine={false} allowDecimals={false} width={40} />
            <Tooltip
              cursor={{ fill: "#9fd8ff", fillOpacity: 0.06 }}
              content={({ payload, label }) => {
                const p = payload?.[0]?.payload as Record<string, number> | undefined;
                if (!p) return null;
                return (
                  <div style={TOOLTIP} className="min-w-48 px-3 py-2">
                    <div className="mb-1 text-dim">{new Date(label as number).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</div>
                    {shown.filter((s) => p[s.key]).map((s) => (
                      <div key={s.key} className="flex justify-between gap-4">
                        <span className="flex items-center gap-1.5 text-mist"><span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.label}</span>
                        <span className="num text-frost">{p[s.key]}</span>
                      </div>
                    ))}
                    <div className="mt-1 flex justify-between gap-4 border-t border-line pt-1">
                      <span className="text-frost">{labels.total}</span><span className="num text-frost">{p.total}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-warn">{labels.avg}</span><span className="num text-frost">{p.avg}</span>
                    </div>
                  </div>
                );
              }}
            />
            {shown.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} stackId="r" fill={s.color} fillOpacity={0.85} isAnimationActive={false}
                radius={i === shown.length - 1 ? [2, 2, 0, 0] : undefined} />
            ))}
            <Line dataKey="avg" stroke="#f2b84b" strokeWidth={1.6} dot={false} type="monotone" isAnimationActive={false} />
            {points.length > 14 && (
              <Brush dataKey="t" height={26} travellerWidth={8} stroke="#23282f" fill="#07080a" tickFormatter={day}>
                <AreaChart data={points}>
                  <Area dataKey="total" stroke="#9fd8ff" fill="#9fd8ff" fillOpacity={0.15} dot={false} isAnimationActive={false} />
                </AreaChart>
              </Brush>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
