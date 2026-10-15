"use client";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

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
