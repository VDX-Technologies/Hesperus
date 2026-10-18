/**
 * VDX Core UI kit for the marketing site: the same tokens as the real app (ink-800 cards, 14 px radius, Plex Mono
 * numbers, ok / warn / alarm colours), drawn as plain HTML and SVG so it stays sharp at any scale.
 */

export const CORE = {
  ok: "#3ddc84",
  warn: "#f2b84b",
  alarm: "#ff5a5f",
  ice: "#9fd8ff",
  orange: "#f08a5d",
  violet: "#b38cf5",
  grid: "#16191d",
  axis: "#6b7079",
};

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-[14px] border border-line-soft bg-ink-800 ${className}`}>{children}</div>;
}

export function Metric({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: "ok" | "warn" }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-[13px] text-mist">{label}</p>
      <p className="core-num mt-2 text-[26px] leading-none" style={tone ? { color: CORE[tone] } : undefined}>
        {value}
        {unit && <span className="ml-1.5 text-[13px] text-dim">{unit}</span>}
      </p>
    </Card>
  );
}

export function Dot({ tone, pulse }: { tone: "ok" | "warn" | "alarm"; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
      {pulse && <span className="core-ping absolute inset-0 rounded-full" style={{ background: CORE[tone] }} />}
      <span className="relative h-2.5 w-2.5 rounded-full" style={{ background: CORE[tone] }} />
    </span>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] font-medium tracking-[0.14em] text-mist uppercase">{children}</p>;
}

export type Line = { label: string; color: string; data: number[]; dashed?: boolean; right?: boolean };
type Axis = { min: number; max: number; ticks: string[] };

/** Time-series chart in the Core style. Solid lines draw in when the face becomes active (`.core-draw`). */
export function Chart({
  lines,
  left,
  right,
  x,
  width,
  height,
  legend = true,
  limit,
  mark,
}: {
  lines: Line[];
  left: Axis;
  right?: Axis;
  x: string[];
  width: number;
  height: number;
  legend?: boolean;
  /** Horizontal threshold on the left axis. */
  limit?: { value: number; label: string };
  /** Vertical marker at a sample index. */
  mark?: { at: number; n: number; label: string };
}) {
  const pad = { l: 52, r: right ? 56 : 16, t: 12, b: legend ? 52 : 28 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const path = (l: Line) => {
    const a = l.right && right ? right : left;
    return l.data
      .map((v, i) => {
        const px = pad.l + (i / (l.data.length - 1)) * w;
        const py = pad.t + h - ((v - a.min) / (a.max - a.min)) * h;
        return `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`;
      })
      .join("");
  };
  const ty = (i: number, n: number) => pad.t + h - (i / (n - 1)) * h;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block">
      {left.ticks.map((t, i) => (
        <g key={`l${t}`}>
          <line x1={pad.l} x2={pad.l + w} y1={ty(i, left.ticks.length)} y2={ty(i, left.ticks.length)} stroke={CORE.grid} />
          <text x={pad.l - 10} y={ty(i, left.ticks.length) + 4} textAnchor="end" fontSize="11" fill={CORE.axis}>
            {t}
          </text>
        </g>
      ))}
      {right?.ticks.map((t, i) => (
        <text key={`r${t}`} x={pad.l + w + 10} y={ty(i, right.ticks.length) + 4} fontSize="11" fill={CORE.axis}>
          {t}
        </text>
      ))}
      {x.map((t, i) => (
        <text key={t} x={pad.l + ((i + 0.5) / x.length) * w} y={pad.t + h + 18} textAnchor="middle" fontSize="11" fill={CORE.axis}>
          {t}
        </text>
      ))}
      {limit && (
        <g>
          <line x1={pad.l} x2={pad.l + w} y1={pad.t + h - ((limit.value - left.min) / (left.max - left.min)) * h} y2={pad.t + h - ((limit.value - left.min) / (left.max - left.min)) * h} stroke={CORE.alarm} strokeOpacity="0.55" strokeDasharray="5 4" />
          <text x={pad.l + w - 4} y={pad.t + h - ((limit.value - left.min) / (left.max - left.min)) * h - 6} textAnchor="end" fontSize="11" fill={CORE.alarm} fillOpacity="0.8">
            {limit.label}
          </text>
        </g>
      )}
      {mark && (
        <g transform={`translate(${pad.l + (mark.at / (mark.n - 1)) * w} 0)`}>
          <rect x="0" y={pad.t} width={w - (mark.at / (mark.n - 1)) * w} height={h} fill={CORE.warn} fillOpacity="0.05" />
          <line y1={pad.t} y2={pad.t + h} stroke={CORE.warn} strokeOpacity="0.6" />
          <text x="6" y={pad.t + 12} fontSize="11" fill={CORE.warn}>
            {mark.label}
          </text>
        </g>
      )}
      {lines.map((l) => (
        <path
          key={l.label}
          d={path(l)}
          fill="none"
          stroke={l.color}
          strokeWidth="1.6"
          strokeLinejoin="round"
          pathLength={l.dashed ? undefined : 1}
          strokeDasharray={l.dashed ? "4 3" : undefined}
          className={l.dashed ? "core-fade" : "core-draw"}
        />
      ))}
      {legend && (
        <g transform={`translate(${pad.l + w / 2} ${height - 14})`}>
          {lines.map((l, i) => {
            const off = (i - (lines.length - 1) / 2) * 96;
            return (
              <g key={l.label} transform={`translate(${off - 36} 0)`}>
                <line x1="0" x2="14" y1="-4" y2="-4" stroke={l.color} strokeWidth="1.6" strokeDasharray={l.dashed ? "2 2" : undefined} />
                <text x="20" y="0" fontSize="12" fill={l.color}>
                  {l.label}
                </text>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}
