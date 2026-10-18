import { CoreShell } from "../CoreShell";
import { hourLabels, noise, series, sun } from "../data";
import { CORE, Card, Chart, Dot, Metric, SectionLabel } from "../ui";

/** 24 h of a Stoma unit ending at 14:30, sampled every 15 minutes. */
const END = 14.5 / 24;
const N = 96;
const air = series(N, END, (t, i) => 15 + 12.5 * sun(t) + noise(i, 1) * 0.25);
const leaf = series(N, END, (t, i) => 13.6 + 14 * sun(t) + noise(i, 2) * 0.3);
const dew = series(N, END, (t, i) => 11.2 + 5 * sun(t) + noise(i, 3) * 0.35);
const rh = series(N, END, (t, i) => 78 - 30 * sun(t) + noise(i, 4) * 1.2);
const vpd = series(N, END, (t, i) => 0.12 + 1.6 * sun(t) + noise(i, 5) * 0.04);
const co2 = series(N, END, (t, i) => 560 - 150 * sun(t) + noise(i, 6) * 14);
const voc = series(N, END, (t, i) => 100 + noise(i, 7) * 6);
const par = series(N, END, (t, i) => 760 * sun(t) * (1 + noise(i, 8) * 0.04));
const uv = series(N, END, (t, i) => 4.2 * sun(t) ** 1.3 * (1 + noise(i, 9) * 0.05));
const X = hourLabels(END);

const METRICS = [
  { label: "Air", value: "26.8", unit: "°C" },
  { label: "Humidity", value: "51", unit: "%" },
  { label: "Leaf", value: "27.1", unit: "°C" },
  { label: "Dew point", value: "15.9", unit: "°C" },
  { label: "Condensation margin", value: "11.2", unit: "°C" },
  { label: "VPD", value: "1.68", unit: "kPa" },
  { label: "CO₂", value: "432", unit: "ppm" },
  { label: "VOC index", value: "98" },
  { label: "Light", value: "41 200", unit: "lx" },
  { label: "PAR (est.)", value: "748", unit: "µmol/m²/s" },
  { label: "UV index", value: "3.9" },
  { label: "Light today (DLI)", value: "17.4", unit: "mol/m²" },
];

const CHART = { width: 716, height: 300 };

/** Face 1: the Stoma module, a sensor in a greenhouse on a clear afternoon. */
export function StomaFace() {
  return (
    <CoreShell workspace="Vivai Demo" nav={["Overview", "Alerts", "Settings"]}>
      <div className="px-[72px] pt-8">
        <p className="text-[15px] text-mist">← Overview</p>
        <div className="mt-6 flex items-end justify-between">
          <div>
            <p className="text-[14px] text-mist">Stoma · #3</p>
            <h3 className="mt-1 text-[32px] font-semibold tracking-[-0.01em]">Stoma 3</h3>
            <p className="mt-3 flex items-center gap-3 text-[15px]">
              <Dot tone="ok" pulse />
              <span style={{ color: CORE.ok }}>Normal</span>
              <span className="ml-3">Last data: 1 min. ago</span>
              <span className="core-num ml-3 text-[13px] text-mist">Signal -94 dBm</span>
            </p>
          </div>
          <div className="flex gap-3 text-[15px]">
            <span className="rounded-[10px] border border-frost px-4 py-2">24 h</span>
            <span className="rounded-[10px] border border-line px-4 py-2 text-mist">7 days</span>
          </div>
        </div>
        <div className="mt-8 grid grid-cols-6 gap-4">
          {METRICS.map((m) => (
            <Metric key={m.label} {...m} />
          ))}
        </div>
        <div className="mt-9">
          <SectionLabel>History</SectionLabel>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Card className="p-4">
            <Chart
              {...CHART}
              x={X}
              left={{ min: 0, max: 32, ticks: ["0°", "8°", "16°", "24°", "32°"] }}
              lines={[
                { label: "Air", color: CORE.orange, data: air },
                { label: "Dew point", color: CORE.ice, data: dew, dashed: true },
                { label: "Leaf", color: CORE.ok, data: leaf },
              ]}
            />
          </Card>
          <Card className="p-4">
            <Chart
              {...CHART}
              x={X}
              left={{ min: 0, max: 100, ticks: ["0%", "25%", "50%", "75%", "100%"] }}
              right={{ min: 0, max: 2.6, ticks: ["0", "0.65", "1.3", "1.95", "2.6 kPa"] }}
              lines={[
                { label: "Humidity", color: CORE.ice, data: rh },
                { label: "VPD", color: CORE.warn, data: vpd, right: true },
              ]}
            />
          </Card>
          <Card className="p-4">
            <Chart
              {...CHART}
              x={X}
              left={{ min: 300, max: 600, ticks: ["300", "450", "600"] }}
              right={{ min: 60, max: 120, ticks: ["60", "90", "120"] }}
              lines={[
                { label: "CO₂", color: "#e9ebee", data: co2 },
                { label: "VOC", color: CORE.violet, data: voc, right: true },
              ]}
            />
          </Card>
          <Card className="p-4">
            <Chart
              {...CHART}
              x={X}
              left={{ min: 0, max: 800, ticks: ["0", "400", "800"] }}
              right={{ min: 0, max: 5, ticks: ["0", "2.5", "5"] }}
              lines={[
                { label: "PAR", color: CORE.violet, data: par },
                { label: "UV", color: CORE.warn, data: uv, right: true },
              ]}
            />
          </Card>
        </div>
      </div>
    </CoreShell>
  );
}
