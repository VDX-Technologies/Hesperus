"use client";
import { useEffect, useRef, useState } from "react";

export interface ThermalFrame {
  w: number;
  h: number;
  data: number[];
}

type Mode = "temp" | "dew";
const SCALE = 24; // canvas pixels per sensor pixel

// "Iron" palette of thermal cameras: black -> purple -> red -> orange -> yellow -> white
export const IRON: [number, number, number, number][] = [
  [0, 0, 0, 10],
  [0.2, 70, 0, 140],
  [0.45, 200, 30, 90],
  [0.65, 245, 110, 20],
  [0.85, 255, 210, 50],
  [1, 255, 255, 230],
];
// Condensation risk: distance from the dew point. Blue = wet, green = safe, amber = dry/hot.
export const DEW: [number, number, number, number][] = [
  [0, 40, 90, 255],
  [0.2, 120, 190, 255],
  [0.35, 61, 220, 132],
  [0.7, 61, 220, 132],
  [1, 242, 184, 75],
];

export function ramp(stops: [number, number, number, number][], x: number): [number, number, number] {
  const v = Math.min(1, Math.max(0, x));
  for (let i = 1; i < stops.length; i++) {
    const [p1, ...c1] = stops[i];
    const [p0, ...c0] = stops[i - 1];
    if (v <= p1) {
      const f = (v - p0) / (p1 - p0 || 1);
      return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * f) as [number, number, number];
    }
  }
  return stops.at(-1)!.slice(1) as [number, number, number];
}

/** Bilinear sample of the frame at fractional sensor coordinates. */
function sample(f: ThermalFrame, x: number, y: number) {
  const cx = Math.min(f.w - 1, Math.max(0, x)),
    cy = Math.min(f.h - 1, Math.max(0, y));
  const x0 = Math.floor(cx),
    y0 = Math.floor(cy);
  const x1 = Math.min(f.w - 1, x0 + 1),
    y1 = Math.min(f.h - 1, y0 + 1);
  const fx = cx - x0,
    fy = cy - y0;
  const at = (i: number, j: number) => f.data[j * f.w + i];
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

/**
 * What the Stoma infrared array sees, as a heat map. "temp" colours by temperature (auto range),
 * "dew" colours by distance from the dew point so wet leaves stand out in blue.
 */
export function ThermalMap({
  frame,
  dew,
  air,
  labels,
}: {
  frame: ThermalFrame;
  dew: number | null;
  air: number | null;
  labels: { temp: string; dew: string; min: string; max: string; median: string; wet: string; dry: string; hover: string; vsAir: string };
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>("temp");
  const [hover, setHover] = useState<{ x: number; y: number; w: number; v: number } | null>(null);
  const sorted = [...frame.data].sort((a, b) => a - b);
  const lo = sorted[0],
    hi = sorted.at(-1)!,
    med = sorted[Math.floor(sorted.length / 2)];
  const canDew = dew !== null && mode === "dew";

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const W = frame.w * SCALE,
      H = frame.h * SCALE;
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(W, H);
    const span = Math.max(0.5, hi - lo);
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        const v = sample(frame, (px + 0.5) / SCALE - 0.5, (py + 0.5) / SCALE - 0.5);
        // dew mode: 0 °C from the dew point = 0.2, +8 °C = 1
        const [r, g, b] = canDew ? ramp(DEW, 0.2 + (v - dew!) / 10) : ramp(IRON, (v - lo) / span);
        const i = (py * W + px) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    // max and min markers
    const mark = (v: number, color: string) => {
      const k = frame.data.indexOf(v);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(((k % frame.w) + 0.5) * SCALE, (Math.floor(k / frame.w) + 0.5) * SCALE, SCALE * 0.45, 0, Math.PI * 2);
      ctx.stroke();
    };
    mark(hi, "#ffffff");
    mark(lo, "#9fd8ff");
  }, [frame, lo, hi, canDew, dew]);

  const legend = canDew
    ? `linear-gradient(90deg, ${DEW.map(([p, r, g, b]) => `rgb(${r},${g},${b}) ${p * 100}%`).join(",")})`
    : `linear-gradient(90deg, ${IRON.map(([p, r, g, b]) => `rgb(${r},${g},${b}) ${p * 100}%`).join(",")})`;
  const f1 = (v: number) => v.toFixed(1);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-mist">
          <span>
            {labels.min} <span className="num text-ice">{f1(lo)}°</span>
          </span>
          <span>
            {labels.median} <span className="num text-frost">{f1(med)}°</span>
          </span>
          <span>
            {labels.max} <span className="num text-frost">{f1(hi)}°</span>
          </span>
          {air !== null && <span className="num text-dim">Δ {f1(med - air)}° {labels.vsAir}</span>}
        </div>
        <div className="flex gap-1">
          {(["temp", "dew"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={m === "dew" && dew === null}
              onClick={() => setMode(m)}
              className={`btn px-2 py-1 text-xs ${mode === m ? "border-frost" : ""}`}
            >
              {labels[m]}
            </button>
          ))}
        </div>
      </div>
      <div className="relative">
        <canvas
          ref={ref}
          className="block w-full rounded-md"
          style={{ aspectRatio: `${frame.w} / ${frame.h}`, imageRendering: "auto" }}
          onPointerDown={(e) => {
            // tap on phones shows the reading at that point
            const r = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * frame.w - 0.5;
            const y = ((e.clientY - r.top) / r.height) * frame.h - 0.5;
            setHover({ x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, v: sample(frame, x, y) });
          }}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * frame.w - 0.5;
            const y = ((e.clientY - r.top) / r.height) * frame.h - 0.5;
            setHover({ x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, v: sample(frame, x, y) });
          }}
          onMouseLeave={() => setHover(null)}
        />
        {hover && (
          <div
            className="num pointer-events-none absolute rounded border border-line bg-ink-800/90 px-2 py-1 text-xs"
            style={{ left: Math.min(hover.x + 12, hover.w - 160), top: hover.y + 12 }}
          >
            {f1(hover.v)} °C{dew !== null && <span className="text-dim"> · {f1(hover.v - dew)}° {labels.hover}</span>}
          </div>
        )}
      </div>
      <div className="mt-2">
        <div className="h-2 rounded" style={{ background: legend }} />
        <div className="num mt-1 flex justify-between text-[11px] text-dim">
          {canDew ? (
            <>
              <span>{labels.wet} ({f1(dew!)}°)</span>
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
