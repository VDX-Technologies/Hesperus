import { CoreShell } from "../CoreShell";
import { noise } from "../data";
import { CORE, SectionLabel } from "../ui";

/** Map area in stage pixels: everything left of the inspector, above the timeline. */
const MW = 1140;
const MH = 800;

/** Closed contour around a hill, wobbled by deterministic noise. */
function contour(cx: number, cy: number, r: number, seed: number) {
  const n = 72;
  return (
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      const k = 1 + 0.16 * Math.sin(3 * a + seed) + 0.08 * Math.sin(5 * a + seed * 2.3) + 0.03 * noise(i, seed);
      return `${i ? "L" : "M"}${(cx + Math.cos(a) * r * k * 1.35).toFixed(1)} ${(cy + Math.sin(a) * r * k).toFixed(1)}`;
    }).join("") + "Z"
  );
}
const HILLS = [
  { cx: 300, cy: 260, rings: 7, step: 34, seed: 1, base: 120 },
  { cx: 860, cy: 600, rings: 5, step: 30, seed: 4, base: 140 },
];

const LAKE = "M690 90 C760 60 870 70 930 120 S990 240 930 280 800 300 740 260 640 150 690 90Z";
const ROAD = "M0 640 C160 610 260 520 420 500 S640 470 720 400 900 330 1140 300";
const TRACK = "M560 760 C590 700 610 660 640 610 S700 520 735 470";
const OTHERS = [
  { d: "M60 420 C160 430 260 460 360 430 S520 360 600 380", dur: 14, id: "T-028" },
  { d: "M1100 520 C1020 540 960 600 900 640 S780 700 700 720", dur: 18, id: "T-030" },
];
const HISTORY = [0.15, 0.3, 0.45, 0.6, 0.75];

/** Fixed sensors: cameras with their field of view, ground sensors as squares. */
const CAMS = [
  { x: 470, y: 600, a: -60, id: "C-3" },
  { x: 900, y: 420, a: 200, id: "C-5" },
];
const GROUND: [number, number, boolean][] = [
  [180, 520, true], [380, 380, true], [600, 300, true], [820, 520, false], [1000, 640, true], [520, 700, true], [260, 680, true],
];
const AREA_B = "M650 420 L800 380 L850 520 L700 560Z";

function sector(x: number, y: number, a: number, r = 190, spread = 50) {
  const p = (d: number) => [x + Math.cos(((a + d) * Math.PI) / 180) * r, y + Math.sin(((a + d) * Math.PI) / 180) * r].map((v) => v.toFixed(1)).join(" ");
  return `M${x} ${y} L${p(-spread / 2)} A${r} ${r} 0 0 1 ${p(spread / 2)}Z`;
}

const EVENTS = [
  { t: "14:27:41", src: "RDR-1", tone: "warn" as const, text: "T-031 entered area B" },
  { t: "14:24:10", src: "RDR-1", tone: "warn" as const, text: "New track T-031, north road" },
  { t: "14:21:02", src: "PTL", tone: "ok" as const, text: "R-2 route complete, 14/14" },
  { t: "14:12:55", src: "GS-04", tone: "warn" as const, text: "Battery 18 %" },
  { t: "13:58:30", src: "C-5", tone: "ok" as const, text: "Area A no activity 40 min" },
  { t: "13:40:00", src: "OPS", tone: "ok" as const, text: "Handover, Rossi on duty" },
];

/** Timeline: 12:30 → 14:30, event positions in minutes from the start. */
const TICKS = ["12:30", "13:00", "13:30", "14:00", "14:30"];
const MARKS = [
  { m: 70, tone: "ok" as const },
  { m: 88, tone: "ok" as const },
  { m: 102, tone: "warn" as const },
  { m: 111, tone: "ok" as const },
  { m: 114, tone: "warn" as const },
  { m: 117.5, tone: "warn" as const },
];

const KV = [
  ["Class", "Ground vehicle, unknown"],
  ["Source", "RDR-1 · C-3 fused"],
  ["First seen", "14:24:10"],
  ["Position", "33T UM 4718 2264"],
  ["Speed", "14 km/h"],
  ["Heading", "312° NW"],
  ["Closest asset", "Gate 2 · 380 m"],
];

/** Face 2: situational awareness for a perimeter, civil in tone. One track selected, everything else context. */
export function DefenseFace() {
  return (
    <CoreShell workspace="Northern Site" nav={["Map", "Events", "Assets", "Settings"]} alerts={2}>
      <div className="absolute inset-0 flex">
        <div className="relative flex min-w-0 flex-1 flex-col bg-[#090b0e]">
          <svg viewBox={`0 0 ${MW} ${MH}`} width={MW} height={MH} className="block">
            {HILLS.flatMap((hl) =>
              Array.from({ length: hl.rings }, (_, i) => (
                <path key={`${hl.seed}-${i}`} d={contour(hl.cx, hl.cy, 40 + i * hl.step, hl.seed + i * 0.15)} fill="none" stroke={i % 5 === 0 ? "#222830" : "#161a20"} />
              )),
            )}
            <text x="296" y="180" fontSize="10" fill="#3a414b">180</text>
            <text x="300" y="54" fontSize="10" fill="#3a414b">140</text>
            <path d={LAKE} fill="#0c141c" stroke="#1a2734" />
            <path d={ROAD} fill="none" stroke="#2a2f37" strokeWidth="4" />
            <path d={ROAD} fill="none" stroke="#090b0e" strokeWidth="1.5" strokeDasharray="10 10" />
            {Array.from({ length: 12 }, (_, i) => (
              <g key={`gx${i}`}>
                <line x1={i * 100} x2={i * 100} y1="0" y2={MH} stroke="#9fd8ff" strokeOpacity="0.045" />
                <text x={i * 100 + 4} y="14" fontSize="10" fill="#4a525c" className="core-num">{41 + i}</text>
              </g>
            ))}
            {Array.from({ length: 8 }, (_, i) => (
              <g key={`gy${i}`}>
                <line x1="0" x2={MW} y1={i * 100} y2={i * 100} stroke="#9fd8ff" strokeOpacity="0.045" />
                <text x="4" y={i * 100 - 4} fontSize="10" fill="#4a525c" className="core-num">{i ? 29 - i : ""}</text>
              </g>
            ))}
            {CAMS.map((c) => (
              <g key={c.id}>
                <path d={sector(c.x, c.y, c.a)} fill={CORE.ice} fillOpacity="0.035" stroke={CORE.ice} strokeOpacity="0.18" />
                <rect x={c.x - 5} y={c.y - 5} width="10" height="10" fill="#090b0e" stroke={CORE.ice} strokeWidth="1.5" />
                <text x={c.x + 10} y={c.y + 18} fontSize="11" fill="#6b7079">{c.id}</text>
              </g>
            ))}
            {GROUND.map(([x, y, ok], i) => (
              <rect key={i} x={x - 3.5} y={y - 3.5} width="7" height="7" fill={ok ? "#5f6b78" : CORE.warn} transform={`rotate(45 ${x} ${y})`} />
            ))}
            <path d={AREA_B} fill={CORE.warn} fillOpacity="0.05" stroke={CORE.warn} strokeOpacity="0.7" strokeDasharray="8 5" />
            <text x="660" y="410" fontSize="11" fill={CORE.warn} letterSpacing="1.5">AREA B · RESTRICTED</text>
            {OTHERS.map((t) => (
              <g key={t.id}>
                <path d={t.d} fill="none" stroke="#6b7079" strokeOpacity="0.35" strokeDasharray="1 6" strokeLinecap="round" />
                <circle r="4" fill="#a3a9b2" className="core-move" style={{ offsetPath: `path("${t.d}")`, animationDuration: `${t.dur}s` }} />
              </g>
            ))}
            <path d={TRACK} fill="none" stroke={CORE.warn} strokeOpacity="0.5" strokeWidth="1.5" className="core-draw" pathLength={1} />
            {HISTORY.map((f, i) => {
              // Points sampled along the cubic by eye; the trail only has to read as "where it came from".
              const pts = [[566, 742], [590, 698], [612, 655], [645, 600], [690, 540]];
              return <circle key={f} cx={pts[i][0]} cy={pts[i][1]} r="2.5" fill={CORE.warn} opacity={0.25 + i * 0.12} />;
            })}
            <g transform="translate(735 470)">
              <circle r="11" fill="none" stroke={CORE.warn} className="core-ping-svg" />
              <circle r="5" fill={CORE.warn} />
              <path d="M-22 -14 v-8 h8 M14 -22 h8 v8 M22 14 v8 h-8 M-14 22 h-8 v-8" fill="none" stroke="#e9ebee" strokeWidth="1.5" />
              <line x1="26" y1="-26" x2="60" y2="-60" stroke="#e9ebee" strokeOpacity="0.5" />
              <g transform="translate(60 -84)">
                <rect width="150" height="34" fill="#0d1014" stroke="#2a2f37" />
                <text x="10" y="15" fontSize="12" fill="#e9ebee" className="core-num">T-031</text>
                <text x="10" y="28" fontSize="10" fill="#a3a9b2" className="core-num">14 km/h · 312°</text>
              </g>
            </g>
            <g transform={`translate(24 ${MH - 24})`} fontSize="10" fill="#6b7079">
              <path d="M0 -6 V0 H100 V-6 M50 -3 V0" fill="none" stroke="#6b7079" />
              <text x="0" y="-12">0</text>
              <text x="86" y="-12">500 m</text>
            </g>
            <g transform={`translate(${MW - 40} ${MH - 50})`} stroke="#6b7079" fill="none">
              <circle r="16" />
              <path d="M0 -12 L4 2 L0 0 L-4 2Z" fill="#a3a9b2" stroke="none" />
              <text y="-22" textAnchor="middle" fontSize="10" fill="#6b7079" stroke="none">N</text>
            </g>
          </svg>
          <div className="absolute top-5 right-6 flex items-center gap-5 text-[12px] text-mist">
            {["Terrain", "Sensors", "Tracks", "Areas"].map((l) => (
              <span key={l} className="flex items-center gap-1.5">
                <span className="h-2 w-2 bg-mist/70" />
                {l}
              </span>
            ))}
            <span className="core-num text-frost">14:29:52 CET</span>
          </div>
          <div className="relative flex-1 border-t border-line-soft bg-ink-900 px-6 pt-3">
            <div className="flex text-[11px] text-dim">
              <span className="w-[86px]">Last 2 h</span>
              <div className="relative flex-1">
                {TICKS.map((t, i) => (
                  <span key={t} className="core-num absolute -translate-x-1/2" style={{ left: `${(i / 4) * 100}%` }}>{t}</span>
                ))}
              </div>
            </div>
            {[
              { k: "Events", marks: true },
              { k: "Coverage", marks: false },
            ].map((row) => (
              <div key={row.k} className="mt-3 flex items-center text-[12px] text-mist">
                <span className="w-[86px]">{row.k}</span>
                <div className="relative h-3 flex-1 bg-[#0e1115]">
                  {row.marks
                    ? MARKS.map((m) => <span key={m.m} className="absolute top-0 h-3 w-[3px]" style={{ left: `${(m.m / 120) * 100}%`, background: CORE[m.tone] }} />)
                    : <>
                        <span className="absolute inset-y-0 left-0 bg-[#1f3a2b]" style={{ right: `${(1 - 102 / 120) * 100}%` }} />
                        <span className="absolute inset-y-0 right-0 bg-[#3a2f1a]" style={{ left: `${(102 / 120) * 100}%` }} />
                      </>}
                </div>
              </div>
            ))}
            <span className="absolute top-3 bottom-3 right-6 w-px bg-frost/60" />
          </div>
        </div>
        <aside className="flex w-[460px] shrink-0 flex-col border-l border-line-soft bg-ink-900">
          <div className="border-b border-line-soft px-8 py-6">
            <div className="flex items-baseline justify-between">
              <span className="core-num text-[24px]">T-031</span>
              <span className="text-[13px]" style={{ color: CORE.warn }}>In area B · 2 min</span>
            </div>
            <dl className="mt-5 grid grid-cols-[130px_1fr] gap-y-2.5 text-[14px]">
              {KV.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-mist">{k}</dt>
                  <dd className="core-num text-[13.5px]">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-6 flex gap-2 text-[13px]">
              <span className="border border-frost px-3 py-1.5">Send R-2</span>
              <span className="border border-line px-3 py-1.5 text-mist">Mark as known</span>
              <span className="border border-line px-3 py-1.5 text-mist">C-3 feed</span>
            </div>
          </div>
          <div className="px-8 py-5">
            <SectionLabel>Log</SectionLabel>
            <table className="mt-3 w-full text-[13px]">
              <tbody>
                {EVENTS.map((e, i) => (
                  <tr key={e.t} className="core-rise border-b border-line-soft" style={{ animationDelay: `${0.15 + i * 0.08}s` }}>
                    <td className="core-num w-[78px] py-2.5 align-top text-mist">{e.t}</td>
                    <td className="core-num w-[60px] py-2.5 align-top text-[11.5px] text-dim">{e.src}</td>
                    <td className="py-2.5" style={e.tone === "warn" ? { color: CORE.warn } : undefined}>{e.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </aside>
      </div>
    </CoreShell>
  );
}
