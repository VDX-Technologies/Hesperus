// Reads for the Agronomy console: crops with their place, the treatments register with its
// filters, autocomplete from what was already written, and the Stoma sensors in a crop's area.
import "server-only";
import type { TenantDb } from "../../engine/db";
import { listEvents, type EventRow } from "../../engine/events";
import { listObjects } from "../console";
import type { Phase } from "./index";
import { toRegisterRow, type CropInfo, type RegisterRow } from "./register";

export const TREATMENT = "agronomy.treatment";

export async function listCrops(db: TenantDb, id?: string): Promise<CropInfo[]> {
  return (await listObjects(db, "agronomy", id))
    .filter((o) => o.type === "crop")
    .map((o) => ({
      id: o.id,
      name: o.name,
      species: String(o.properties.species ?? ""),
      variety: typeof o.properties.variety === "string" ? o.properties.variety : null,
      hectares: typeof o.properties.hectares === "number" ? o.properties.hectares : null,
      phase: (o.properties.phase as Phase | undefined) ?? null,
      placeId: o.placeId,
      placePath: o.placePath,
    }));
}

export interface TreatmentFilters {
  cropId?: string;
  product?: string;
  adversity?: string;
  /** yyyy-mm-dd, both days included */
  from?: string;
  to?: string;
}

const day = (s: string | undefined, plus = 0) => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : new Date(d.getTime() + plus * 86400000);
};

/** Treatments, latest versions only, newest first; product and adversity match exactly. */
export async function listTreatments(db: TenantDb, f: TreatmentFilters = {}, crops?: CropInfo[], limit = 1000): Promise<RegisterRow[]> {
  const payload: Record<string, unknown> = {};
  if (f.product) payload.product = f.product;
  if (f.adversity) payload.adversity = f.adversity;
  const events = await listEvents(db, {
    types: [TREATMENT],
    objectId: f.cropId,
    recursive: false,
    from: day(f.from),
    to: day(f.to, 1),
    payload: Object.keys(payload).length ? payload : undefined,
    limit,
  });
  const byId = new Map((crops ?? (await listCrops(db))).map((c) => [c.id, c]));
  return events.map((e: EventRow) => toRegisterRow(e, byId));
}

/** Products and adversities written before, most used first, for autocomplete. */
export async function suggestions(db: TenantDb): Promise<{ product: string[]; adversity: string[] }> {
  const { rows } = await db.query<{ field: "product" | "adversity"; v: string }>(
    `select f.field, e.payload->>f.field v
       from events_current e cross join (values ('product'), ('adversity')) f(field)
      where e.tenant_id = $1 and e.type = $2 and coalesce(e.payload->>f.field, '') <> ''
      group by 1, 2 order by count(*) desc, 2 limit 400`,
    [db.tenantId, TREATMENT],
  );
  return {
    product: rows.filter((r) => r.field === "product").map((r) => r.v),
    adversity: rows.filter((r) => r.field === "adversity").map((r) => r.v),
  };
}

/** Stoma sensors located in the crop's area (or below it); empty when the crop has no place. */
export async function sensorsInPlace(db: TenantDb, placeId: string | null): Promise<{ id: string; name: string }[]> {
  if (!placeId) return [];
  const { rows } = await db.query<{ id: string; name: string | null; external_id: string | null }>(
    `with recursive scope(id) as (
       select $2::uuid
       union
       select l.src_id from links l join scope s on l.dst_id = s.id where l.tenant_id = $1 and l.type = 'part_of'
     )
     select o.id, o.name, o.external_id from objects o
       join object_types t on t.id = o.type_id
       join links l on l.tenant_id = o.tenant_id and l.type = 'located_in' and l.src_id = o.id
      where o.tenant_id = $1 and t.module = 'stoma' and l.dst_id in (select id from scope)
      order by coalesce(o.name, o.external_id)`,
    [db.tenantId, placeId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name ?? r.external_id ?? r.id.slice(0, 8) }));
}
