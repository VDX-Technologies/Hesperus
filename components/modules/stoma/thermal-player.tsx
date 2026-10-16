"use client";
import { useEffect, useMemo, useState } from "react";
import { SCENARIOS, scenarioFrame, type Scenario } from "@/lib/modules/stoma/ir-sim";
import { ThermalMap, type ThermalFrame } from "./thermal-map";

export interface ThermalShot {
  t: number;
  frame: ThermalFrame;
  air: number | null;
  dew: number | null;
}

type MapLabels = Parameters<typeof ThermalMap>[0]["labels"];
interface PlayerLabels {
  live: string;
  demo: string;
  play: string;
  pause: string;
  scenarios: Record<Scenario, { name: string; desc: string }>;
}

/** Small seeded PRNG so the demo frames are the same on server and client. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEPS = 48; // demo day in half hours

/**
 * Thermal map with a time-lapse: "live" replays the last 24 h of real frames from this sensor,
 * "demo" plays a simulated day for a chosen scenario (water stress, condensation, hot spot).
 */
export function ThermalPlayer({ history, labels, playerLabels }: { history: ThermalShot[]; labels: MapLabels; playerLabels: PlayerLabels }) {
  const [source, setSource] = useState<"live" | "demo">(history.length ? "live" : "demo");
  const [scenario, setScenario] = useState<Scenario>("stress");
  const [i, setI] = useState(history.length ? history.length - 1 : 24);
  const [playing, setPlaying] = useState(false);

  const demo = useMemo(
    () =>
      Array.from({ length: STEPS }, (_, k) => {
        const s = scenarioFrame(scenario, k / 2, rng(k + 1));
        return { t: k * 1800000, frame: s.frame, air: s.air, dew: s.dew };
      }),
    [scenario],
  );
  const shots = source === "live" ? history : demo;
  const n = shots.length;
  const cur = shots[Math.min(i, n - 1)];

  useEffect(() => {
    if (!playing || n < 2) return;
    const id = setInterval(() => setI((k) => (k + 1) % n), 450);
    return () => clearInterval(id);
  }, [playing, n]);

  const when =
    source === "live"
      ? new Date(cur.t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
      : `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <div className="flex rounded-lg border border-line p-0.5">
          {(["live", "demo"] as const).map((s) => (
            <button
              key={s}
              type="button"
              disabled={s === "live" && !history.length}
              onClick={() => {
                setSource(s);
                setI(s === "live" ? history.length - 1 : 24);
                setPlaying(s === "demo");
              }}
              className={`rounded-md px-2.5 py-1 disabled:opacity-40 ${source === s ? "bg-steel text-frost" : "text-mist"}`}
            >
              {playerLabels[s]}
            </button>
          ))}
        </div>
        {source === "demo" &&
          SCENARIOS.map((s) => (
            <button key={s} type="button" onClick={() => setScenario(s)} className={`btn px-2 py-1 text-xs ${scenario === s ? "border-frost" : ""}`}>
              {playerLabels.scenarios[s].name}
            </button>
          ))}
      </div>
      {source === "demo" && <p className="mb-3 text-xs text-mist">{playerLabels.scenarios[scenario].desc}</p>}
      <ThermalMap frame={cur.frame} dew={cur.dew} air={cur.air} labels={labels} />
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? playerLabels.pause : playerLabels.play}
          className="btn flex h-9 w-9 shrink-0 items-center justify-center p-0"
        >
          {playing ? (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
              <rect x="3" y="2" width="3.5" height="12" rx="1" />
              <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
              <path d="M4 2.5v11l9.5-5.5z" />
            </svg>
          )}
        </button>
        <input
          type="range"
          min={0}
          max={n - 1}
          value={Math.min(i, n - 1)}
          onChange={(e) => {
            setPlaying(false);
            setI(Number(e.target.value));
          }}
          className="h-9 flex-1 accent-[#9fd8ff]"
        />
        <span className="num w-24 shrink-0 text-right text-xs text-mist">{when}</span>
      </div>
    </div>
  );
}
