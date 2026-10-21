"use client";
import { useMemo, useState } from "react";
import { DEW, IRON, ramp } from "./thermal-map";

type Mode = "temp" | "dew";
/** Hourly averages as [ts ms, value]. */
export type HourlyPoints = [number, number][];

/**
 * Leaf temperature hour by hour: one row per day, one cell per hour (viewer's local time).
 * For single-point infrared sensors, which have no frame to draw. "dew" colours the
 * distance between leaf and dew point, like the thermal map.
 */
export function LeafCalendar({
  leaf,
  dew,
  days,
  locale,
  labels,
}: {
  leaf: HourlyPoints;
  dew: HourlyPoints;
  days: number;
  locale: string;
  labels: { temp: string; dew: string; wet: string; dry: string; empty: string; fromDew: string };
}) {
  const [mode, setMode] = useState<Mode>("temp");
  const [hover, setHover] = useState<{ day: number; hour: number } | null>(null);

  const { rows, lo, hi } = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const rows = Array.from({ length: days }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return { day: d, leaf: Array<number | null>(24).fill(null), dew: Array<number | null>(24).fill(null) };
    });
    const put = (pts: HourlyPoints, k: "leaf" | "dew") => {
      for (const [ts, v] of pts) {
        const d = new Date(ts);
        const day = new Date(d);
        day.setHours(0, 0, 0, 0);
        const i = Math.round((day.getTime() - start.getTime()) / 86400000);
        if (i >= 0 && i < days) rows[i][k][d.getHours()] = v;
      }
    };
    put(leaf, "leaf");
    put(dew, "dew");
    const all = leaf.map(([, v]) => v);
    return { rows: rows.reverse(), lo: Math.min(...all), hi: Math.max(...all) };
  }, [leaf, dew, days]);

  if (!leaf.length) return <p className="text-xs text-dim">{labels.empty}</p>;

  const canDew = mode === "dew" && dew.length > 0;
  const span = Math.max(0.5, hi - lo);
  const color = (l: number | null, d: number | null) => {
    if (l === null || (canDew && d === null)) return undefined;
    const [r, g, b] = canDew ? ramp(DEW, 0.2 + (l - d!) / 10) : ramp(IRON, (l - lo) / span);
    return `rgb(${r},${g},${b})`;
  };
  const legend = `linear-gradient(90deg, ${(canDew ? DEW : IRON).map(([p, r, g, b]) => `rgb(${r},${g},${b}) ${p * 100}%`).join(",")})`;
  const f1 = (v: number) => v.toFixed(1);
  const dayFmt = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric" });
  const cell = hover && rows[hover.day];
  const hl = cell?.leaf[hover!.hour] ?? null,
    hd = cell?.dew[hover!.hour] ?? null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="num min-h-4 text-mist">
          {cell && hl !== null && (
            <>
              {dayFmt.format(cell.day)} · {String(hover!.hour).padStart(2, "0")}:00 <span className="text-frost">{f1(hl)} °C</span>
              {hd !== null && <span className="text-dim"> · {f1(hl - hd)}° {labels.fromDew}</span>}
            </>
          )}
        </div>
        <div className="flex gap-1">
          {(["temp", "dew"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={m === "dew" && !dew.length}
              onClick={() => setMode(m)}
              className={`btn px-2 py-1 text-xs ${mode === m ? "border-frost" : ""}`}
            >
              {labels[m]}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-[2px]" onMouseLeave={() => setHover(null)}>
        {rows.map((r, i) => (
          <div key={r.day.getTime()} className="contents">
            <span className="num text-right text-[10px] text-dim">{dayFmt.format(r.day)}</span>
            <div className="grid grid-cols-24 gap-[2px]">
              {r.leaf.map((l, h) => (
                <div
                  key={h}
                  className="h-3 rounded-[2px] bg-steel"
                  style={{ background: color(l, r.dew[h]) }}
                  onMouseEnter={() => setHover({ day: i, hour: h })}
                  onPointerDown={() => setHover({ day: i, hour: h })}
                />
              ))}
            </div>
          </div>
        ))}
        <span />
        <div className="num mt-1 flex justify-between text-[10px] text-dim">
          {[0, 6, 12, 18].map((h) => (
            <span key={h}>{String(h).padStart(2, "0")}</span>
          ))}
          <span>24</span>
        </div>
      </div>
      <div className="mt-3">
        <div className="h-2 rounded" style={{ background: legend }} />
        <div className="num mt-1 flex justify-between text-[11px] text-dim">
          {canDew ? (
            <>
              <span>{labels.wet}</span>
              <span>{labels.dry} (+8°)</span>
            </>
          ) : (
            <>
              <span>{f1(lo)} °C</span>
              <span>{f1(hi)} °C</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
