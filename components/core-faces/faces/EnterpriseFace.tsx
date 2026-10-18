import { CoreShell } from "../CoreShell";
import { noise, series } from "../data";
import { CORE, Card, Chart, Dot, SectionLabel } from "../ui";

/** Schedule window, 06:00 → 22:00, in hours. */
const FROM = 6;
const SPAN = 16;
const NOW = 14.5;

type Order = { id: string; from: number; to: number; slow?: boolean; ghost?: boolean };
const SCHEDULE: { line: string; plant: string; oee: string; warn?: boolean; orders: Order[] }[] = [
  { line: "A1", plant: "BS", oee: "88.4", orders: [{ id: "4462", from: 6, to: 10.5 }, { id: "4466", from: 10.75, to: 16 }, { id: "4473", from: 16.25, to: 21.5 }] },
  { line: "A2", plant: "BS", oee: "86.1", orders: [{ id: "4463", from: 6, to: 12.25 }, { id: "4469", from: 12.5, to: 19 }] },
  { line: "B1", plant: "LY", oee: "71.9", warn: true, orders: [{ id: "4464", from: 6, to: 13.1 }, { id: "4464", from: 13.1, to: 16, slow: true }, { id: "4471", from: 16.25, to: 21.75, slow: true }] },
  { line: "B2", plant: "LY", oee: "84.7", orders: [{ id: "4465", from: 6, to: 11 }, { id: "4468", from: 11.25, to: 16.5 }, { id: "4471", from: 16.75, to: 21.5, ghost: true }] },
];

/** 8 h of spindle vibration and cycle time on B1, every 5 minutes, drifting from 13:10. */
const N = 96;
const DRIFT = 62;
const vib = series(N, 0, (_, i) => 2.05 + noise(i, 11) * 0.1 + (i > DRIFT ? (i - DRIFT) ** 1.3 * 0.022 : 0));
const cycle = series(N, 0, (_, i) => 31.8 + noise(i, 12) * 0.35 + (i > DRIFT ? (i - DRIFT) * 0.11 : 0));

const TRACE = [
  { sys: "MES", t: "13:10", text: "B1 cycle time 31.8 → 35.4 s, same mould, same material lot." },
  { sys: "IoT", t: "13:12", text: "Spindle vibration +38 %, load flat. Pattern matches bearing wear on A2, March." },
  { sys: "CMMS", t: "—", text: "B1 bearing last replaced 14 months ago, interval 12." },
  { sys: "ERP", t: "—", text: "Order 4471 due Thu 09:00. At current rate B1 finishes Thu 11:40." },
];

const pct = (h: number) => `${((h - FROM) / SPAN) * 100}%`;

/** Face 3: one anomaly on one line, explained by joining four systems that never talked to each other. */
export function EnterpriseFace() {
  return (
    <CoreShell workspace="Manifattura Demo" nav={["Overview", "Lines", "Orders", "Alerts"]} active={1} alerts={1}>
      <div className="grid h-full grid-cols-[1fr_460px] gap-6 px-[72px] py-8">
        <div className="flex min-w-0 flex-col">
          <p className="text-[15px] text-mist">Lines / Lyon</p>
          <div className="mt-4 flex items-end justify-between">
            <div>
              <h3 className="text-[32px] font-semibold tracking-[-0.01em]">Line B1 · Injection moulding</h3>
              <p className="mt-3 flex items-center gap-3 text-[15px]">
                <Dot tone="warn" pulse />
                <span style={{ color: CORE.warn }}>Degraded since 13:10</span>
                <span className="core-num ml-3 text-[13px] text-mist">OEE 71.9 % · target 85</span>
              </p>
            </div>
            <div className="flex gap-3 text-[15px]">
              <span className="rounded-[10px] border border-frost px-4 py-2">Today</span>
              <span className="rounded-[10px] border border-line px-4 py-2 text-mist">Week</span>
            </div>
          </div>

          <div className="mt-8 flex items-baseline justify-between">
            <SectionLabel>Schedule</SectionLabel>
            <span className="text-[12px] text-dim">
              <span className="mr-1 inline-block h-2 w-3 align-middle core-hatch" /> slowed &nbsp;
              <span className="mr-1 ml-3 inline-block h-2 w-3 border border-dashed border-ice align-middle" /> proposed
            </span>
          </div>
          <div className="relative mt-3">
            <div className="ml-[150px] flex text-[11px] text-dim">
              {[6, 10, 14, 18, 22].map((h) => (
                <span key={h} className="core-num absolute -translate-x-1/2" style={{ left: `calc(150px + (100% - 150px) * ${(h - FROM) / SPAN})` }}>
                  {String(h).padStart(2, "0")}:00
                </span>
              ))}
            </div>
            <div className="mt-6 border-t border-line-soft">
              {SCHEDULE.map((r) => (
                <div key={r.line} className="flex h-[46px] items-center border-b border-line-soft">
                  <span className="flex w-[150px] items-center gap-2 text-[14px]">
                    <span style={r.warn ? { color: CORE.warn } : undefined}>{r.line}</span>
                    <span className="text-[11px] text-dim">{r.plant}</span>
                    <span className="core-num ml-auto pr-4 text-[13px]" style={{ color: r.warn ? CORE.warn : "#a3a9b2" }}>{r.oee}</span>
                  </span>
                  <div className="relative h-[26px] flex-1">
                    {r.orders.map((o, k) => (
                      <span
                        key={k}
                        className={`core-num absolute inset-y-0 flex items-center overflow-hidden px-2 text-[11.5px] ${o.ghost ? "border border-dashed border-ice text-ice" : o.slow ? "core-hatch text-[#f2b84b]" : "bg-[#1a1e24] text-mist"}`}
                        style={{ left: pct(o.from), width: `calc(${pct(o.to)} - ${pct(o.from)} - 2px)` }}
                      >
                        {o.from === 13.1 ? "" : o.id}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <span className="absolute top-5 bottom-0 w-px bg-frost/70" style={{ left: `calc(150px + (100% - 150px) * ${(NOW - FROM) / SPAN})` }} />
          </div>

          <Card className="mt-8 p-5">
            <div className="flex items-baseline justify-between">
              <SectionLabel>B1 · spindle vibration and cycle time</SectionLabel>
              <span className="core-num text-[12px] text-dim">06:30 – 14:30</span>
            </div>
            <div className="mt-2">
              <Chart
                width={880}
                height={250}
                x={["07:00", "09:00", "11:00", "13:00"]}
                left={{ min: 1.5, max: 4, ticks: ["1.5", "2.3", "3.2", "4 mm/s"] }}
                right={{ min: 28, max: 40, ticks: ["28", "32", "36", "40 s"] }}
                limit={{ value: 3.5, label: "ISO 10816 alert" }}
                mark={{ at: DRIFT, n: N, label: "13:10" }}
                lines={[
                  { label: "Vibration", color: CORE.warn, data: vib },
                  { label: "Cycle time", color: "#a3a9b2", data: cycle, right: true, dashed: true },
                ]}
              />
            </div>
          </Card>
        </div>

        <aside className="flex flex-col border-l border-line-soft pl-8">
          <SectionLabel>Why B1 slowed</SectionLabel>
          <ol className="relative mt-5">
            <span className="absolute top-2 bottom-6 left-[5px] w-px bg-line" />
            {TRACE.map((e, i) => (
              <li key={e.sys} className="core-rise relative pb-5 pl-8" style={{ animationDelay: `${0.25 + i * 0.18}s` }}>
                <span className="absolute top-[5px] left-0 h-[11px] w-[11px] rounded-full border-2 border-ink-900" style={{ background: i < 2 ? CORE.warn : "#6b7079" }} />
                <p className="core-num flex gap-3 text-[11.5px] tracking-[0.06em] text-dim">
                  <span className="text-mist">{e.sys}</span>
                  {e.t}
                </p>
                <p className="mt-1 text-[14.5px] leading-[1.45]">{e.text}</p>
              </li>
            ))}
          </ol>
          <div className="core-rise mt-2 border-t border-line pt-5" style={{ animationDelay: "1s" }}>
            <p className="text-[13px] text-mist">Proposed</p>
            <p className="mt-2 text-[16px] leading-[1.45]">Move 4471 to B2 at 16:45. Replace the B1 bearing at the changeover.</p>
            <dl className="core-num mt-4 grid grid-cols-2 gap-y-1.5 text-[13px]">
              <dt className="text-mist">4471 finish</dt>
              <dd>Wed 21:30</dd>
              <dt className="text-mist">B1 downtime</dt>
              <dd>1 h 20 min</dd>
              <dt className="text-mist">Due date</dt>
              <dd style={{ color: CORE.ok }}>kept</dd>
            </dl>
            <div className="mt-5 flex gap-2 text-[14px]">
              <span className="rounded-[10px] bg-frost px-4 py-2 text-ink-900">Apply to schedule</span>
              <span className="rounded-[10px] border border-line px-4 py-2 text-mist">Open work order</span>
            </div>
          </div>
        </aside>
      </div>
    </CoreShell>
  );
}
