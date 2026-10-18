import type { TreatmentFilters } from "@/lib/packages/agronomy/console";

const one = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] : v ?? undefined) || undefined;

/** Register filters from the query string, shared by the page and the export. */
export function filtersFrom(get: (k: string) => string | string[] | null | undefined): TreatmentFilters {
  return { cropId: one(get("crop")), product: one(get("product")), adversity: one(get("adversity")), from: one(get("from")), to: one(get("to")) };
}

export function filterQuery(f: TreatmentFilters): string {
  const q = new URLSearchParams();
  for (const [k, v] of [["crop", f.cropId], ["product", f.product], ["adversity", f.adversity], ["from", f.from], ["to", f.to]] as const) if (v) q.set(k, v);
  return q.toString();
}
