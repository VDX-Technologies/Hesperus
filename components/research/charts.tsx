"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bar, BarChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";

const TOOLTIP = { background: "#111317", border: "1px solid #23282f", borderRadius: 8, fontSize: 12 };
const AXIS = { stroke: "#6b7079", fontSize: 11, tickLine: false } as const;

export interface Bin {
  lo: number;
  hi: number;
  n: number;
}

const fmt = (v: number, locale: string) => v.toLocaleString(locale, { maximumSignificantDigits: 4 });

/**
 * How a numeric property spreads over the results the table shows. Dragging across bins (or
 * clicking one) narrows the table to that range: `query` is the page's query string without the
 * two bounds, which go in `minKey` / `maxKey`.
 */
export function Histogram({
  bins, path, query, minKey, maxKey, locale, labels, height = 180,
}: {
  bins: Bin[]; path: string; query: string; minKey: string; maxKey: string; locale: string;
  labels: { count: string; range: string }; height?: number;
}) {
  const router = useRouter();
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const rows = bins.map((b, i) => ({ i, n: b.n, lo: b.lo, hi: b.hi }));
  const index = (s: { activeIndex?: unknown }) => (s.activeIndex === undefined || s.activeIndex === null ? null : Number(s.activeIndex));
  const done = () => {
    if (from !== null) {
      const a = Math.min(from, to ?? from), b = Math.max(from, to ?? from);
      const q = new URLSearchParams(query);
      q.set(minKey, String(bins[a].lo));
      q.set(maxKey, String(bins[b].hi));
      router.push(`${path}?${q}`, { scroll: false });
    }
    setFrom(null);
    setTo(null);
  };
  return (
    <div className="select-none" title={labels.range}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={rows}
          margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
          barCategoryGap={1}
          onMouseDown={(s) => { const i = index(s); setFrom(i); setTo(i); }}
          onMouseMove={(s) => { if (from !== null) setTo(index(s) ?? to); }}
          onMouseUp={done}
          onMouseLeave={() => { setFrom(null); setTo(null); }}
          style={{ cursor: "crosshair" }}
        >
          <CartesianGrid stroke="#16191d" vertical={false} />
          <XAxis dataKey="i" tickFormatter={(i: number) => (rows[i] ? fmt(rows[i].lo, locale) : "")} {...AXIS} minTickGap={24} />
          <YAxis {...AXIS} axisLine={false} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: "#1d252e" }}
            content={({ payload }) => {
              const d = payload?.[0]?.payload as (typeof rows)[number] | undefined;
              if (!d) return null;
              return (
                <div style={TOOLTIP} className="px-3 py-2">
                  <div className="num text-mist">{fmt(d.lo, locale)} – {fmt(d.hi, locale)}</div>
                  <div className="text-frost"><span className="num">{d.n}</span> {labels.count}</div>
                </div>
              );
            }}
          />
          <Bar dataKey="n" fill="#9fd8ff" fillOpacity={0.8} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          {from !== null && to !== null && <ReferenceArea x1={Math.min(from, to)} x2={Math.max(from, to)} fill="#9fd8ff" fillOpacity={0.12} stroke="#9fd8ff" strokeOpacity={0.4} />}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface Point {
  id: string;
  name: string;
  x: number;
  y: number;
}

/** Two numeric properties of the results against each other; a point opens its result. */
export function ResultScatter({
  points, href, xLabel, yLabel, locale, height = 260,
}: { points: Point[]; href: string; xLabel: string; yLabel: string; locale: string; height?: number }) {
  const router = useRouter();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
        <CartesianGrid stroke="#16191d" />
        <XAxis dataKey="x" type="number" name={xLabel} domain={["auto", "auto"]} tickFormatter={(v: number) => fmt(v, locale)} {...AXIS} />
        <YAxis dataKey="y" type="number" name={yLabel} domain={["auto", "auto"]} tickFormatter={(v: number) => fmt(v, locale)} {...AXIS} axisLine={false} />
        <ZAxis range={[36, 36]} />
        <Tooltip
          cursor={{ stroke: "#23282f" }}
          content={({ payload }) => {
            const d = payload?.[0]?.payload as Point | undefined;
            if (!d) return null;
            return (
              <div style={TOOLTIP} className="px-3 py-2">
                <div className="text-frost">{d.name}</div>
                <div className="text-mist">{xLabel}: <span className="num text-frost">{fmt(d.x, locale)}</span></div>
                <div className="text-mist">{yLabel}: <span className="num text-frost">{fmt(d.y, locale)}</span></div>
              </div>
            );
          }}
        />
        <Scatter
          data={points}
          fill="#9fd8ff"
          fillOpacity={0.7}
          cursor="pointer"
          isAnimationActive={false}
          onClick={(p) => {
            const id = (p as { payload?: Point }).payload?.id;
            if (id) router.push(`${href}/${id}`);
          }}
        />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
