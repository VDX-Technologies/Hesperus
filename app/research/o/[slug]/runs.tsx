import type { EventRow } from "@/lib/engine/events";
import type { PropertySpec } from "@/lib/engine/package";
import { fieldText } from "@/lib/engine/registers";
import type { Locale } from "@/lib/packages/types";
import { RESEARCH } from "@/lib/research";

const TONE: Record<string, string> = { failed: "border-alarm/40 bg-alarm/10 text-alarm", partial: "border-warn/40 bg-warn/10 text-warn" };

export function Outcome({ spec, value, locale }: { spec?: PropertySpec; value: unknown; locale: Locale }) {
  if (value === undefined || value === null || value === "") return null;
  const text = spec ? fieldText(spec, value, locale) : String(value);
  const tone = TONE[String(value)];
  return tone ? <span className={`rounded border px-1.5 py-0.5 text-xs ${tone}`}>{text}</span> : <>{text}</>;
}

export const runLabel = (e: EventRow, locale: Locale) =>
  `${e.ts.toLocaleString(locale)}${e.payload.commit ? ` · ${String(e.payload.commit).slice(0, 10)}` : ""}${e.payload[RESEARCH.outcome] ? ` · ${String(e.payload[RESEARCH.outcome])}` : ""}`;
