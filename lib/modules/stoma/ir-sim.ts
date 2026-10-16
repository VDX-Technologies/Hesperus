/**
 * Synthetic Stoma infrared frames for the demo: shared by the seed script and the scenario player.
 * A 16x12 frame shows a few leaves (blobs at leaf temperature) over soil/pots that run warmer than
 * the air by day and colder at night, with an optional hot patch (dry or stressed plants) and an
 * optional cold top edge (leaves facing the roof, where condensation starts).
 */
import { dewPoint } from ".";

export const IR_W = 16,
  IR_H = 12;
const LEAVES = [
  [3, 3, 3.2],
  [8, 4, 3.6],
  [13, 3, 2.8],
  [5, 8, 3.4],
  [11, 8, 3.8],
];

export function irFrame(leaf: number, air: number, day: number, hot: number, wetEdge: number, rand: () => number = Math.random) {
  const out: number[] = [];
  for (let y = 0; y < IR_H; y++)
    for (let x = 0; x < IR_W; x++) {
      let cover = 0;
      for (const [cx, cy, r] of LEAVES) cover = Math.max(cover, Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (r * r)));
      const soil = air + 1.5 * day - 1.5 * (1 - day);
      let v = leaf * cover + soil * (1 - cover);
      if (hot && (x - 12) ** 2 + (y - 8) ** 2 < 5) v += hot; // stressed patch
      if (wetEdge && y < 3) v -= wetEdge; // leaves facing the cold roof cool most
      out.push(Math.round((v + (rand() - 0.5) * 0.3) * 100) / 100);
    }
  return out;
}

export type Scenario = "normal" | "stress" | "dew" | "hotspot";
export const SCENARIOS: Scenario[] = ["normal", "stress", "dew", "hotspot"];

/** Daylight 0..1 between 6:00 and 20:00. */
export const daylight = (h: number) => Math.max(0, Math.sin(((h - 6) / 14) * Math.PI));

/** One frame of a demo scenario at hour h (0-24), with the air conditions it was taken in. */
export function scenarioFrame(s: Scenario, h: number, rand: () => number = Math.random) {
  const day = daylight(h);
  const air = 15 + 11 * day;
  const rh = s === "dew" ? 97 - 20 * day : 82 - 30 * day;
  let leaf = air + (day > 0.1 ? 1.2 * day : -0.8);
  if (s === "stress") leaf += 4 * day; // stomata close at midday, leaves heat up
  if (s === "dew") leaf -= 2.4 * (1 - day); // radiative cooling at night: leaves below the dew point
  const hot = s === "hotspot" ? 2 + 5 * day : 0;
  const wet = s === "dew" ? 1.5 * (1 - day) : 0;
  return { frame: { w: IR_W, h: IR_H, data: irFrame(leaf, air, day, hot, wet, rand) }, air, dew: dewPoint(air, rh) };
}
