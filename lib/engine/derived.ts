// Declarative derived metrics. Stateless functions use the current message only; delta and
// rate keep the previous input value per object in objects.state.derived.
import type { DerivedDef } from "./package";

export type DerivedState = Record<string, { ts: number; v: number }>;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Adds derived values to `metrics` (in place) and updates `state`. Out-of-order points never move state back. */
export function applyDerived(
  defs: DerivedDef[], metrics: Record<string, number | null | undefined>, ts: Date, state: DerivedState,
): void {
  for (const d of defs) {
    const xs = d.inputs.map((k) => metrics[k]);
    let out: number | undefined;
    if (d.fn === "delta" || d.fn === "rate") {
      const x = xs[0];
      if (!finite(x)) continue;
      const prev = state[d.key];
      if (prev && prev.ts >= ts.getTime()) continue;
      state[d.key] = { ts: ts.getTime(), v: x };
      if (!prev) continue;
      out = d.fn === "delta" ? x - prev.v : (x - prev.v) / ((ts.getTime() - prev.ts) / 1000);
    } else {
      if (!xs.length || !xs.every(finite)) continue;
      const v = xs as number[];
      switch (d.fn) {
        case "avg": out = v.reduce((a, b) => a + b, 0) / v.length; break;
        case "sum": out = v.reduce((a, b) => a + b, 0); break;
        case "min": out = Math.min(...v); break;
        case "max": out = Math.max(...v); break;
        case "diff": out = v[0] - v[1]; break;
        case "ratio": out = v[1] === 0 ? undefined : v[0] / v[1]; break;
      }
    }
    if (finite(out)) metrics[d.key] = out;
  }
}
