import type { Db } from "../../engine/db";
import { registerPackage } from "../../engine/ingest";
import { validateProperties } from "../../engine/schema";
import type { RawMessage } from "../../engine/connectors";
import type { Source } from "../../engine/sources";
import type { Actor } from "../../engine/audit";
import { parseDate, parseNumber } from "../records";
import { agronomyPackage, PHASES, type Phase } from "./index";

export type Register = "treatment" | "harvest" | "sowing";

const text = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const KIND_WORDS: [Register, RegExp][] = [
  ["treatment", /tratt|difesa|fitosan|irrora|spray|treat|antiperon|fungic|insettic|diserb|erbic/],
  ["harvest", /raccol|vendemm|harvest|resa|yield|trebbi|mietit/],
  ["sowing", /semin|sow|trapiant|transplant|impiant/],
];

export function classify(messages: RawMessage[], hint = ""): Register | null {
  const rows = messages.filter((m) => text(m.subject));
  if (!rows.length) return null;
  const votes = new Map<Register, number>();
  const vote = (k: Register, w = 1) => votes.set(k, (votes.get(k) ?? 0) + w);
  for (const m of rows) {
    const said = fold(`${text(m.kind)} ${hint}`);
    const named = KIND_WORDS.find(([, re]) => re.test(said));
    if (named) vote(named[0], 2);
    else if (text(m.product) && (text(m.dose) || text(m.adversity))) vote("treatment");
    else if (text(m.adversity)) vote("treatment");
    else if (text(m.quantity) && !text(m.product)) vote("harvest");
  }
  const [best] = [...votes].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= rows.length * 0.6 ? best[0] : null;
}

export function unitOf(s: string, fallback: "kg" | "L" = "L"): "kg" | "L" | "t" {
  const u = fold(s).replace(/[^a-z]/g, " ");
  if (/\b(t|ton|tonn\w*)\b/.test(u)) return "t";
  if (/\b(kg|g|gr|q|ql|qli|quintal\w*|chil\w*)\b/.test(u)) return "kg";
  if (/\b(l|lt|lit\w*|hl|ml|cc)\b/.test(u)) return "L";
  return fallback;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

interface Crop { id: string; hectares: number | null; phase: Phase | null }

export interface AgronomyImport {
  register: Register;
  accepted: number;
  rejected: { index: number; error: string }[];
  events: number;
  objectIds: string[];
}

export async function importAgronomy(
  db: Db,
  source: Source,
  messages: RawMessage[],
  register: Register,
  actor: Actor,
  opts: { units?: string; now?: Date; documentId?: string } = {},
): Promise<AgronomyImport> {
  const now = opts.now ?? new Date();
  const tenant = source.tenant_id;
  const reg = await registerPackage(db, agronomyPackage);
  const cropType = reg.types.get("crop")!;
  const spec = agronomyPackage.eventTypes!.find((t) => t.key === register)!;
  const out: AgronomyImport = { register, accepted: 0, rejected: [], events: 0, objectIds: [] };

  await db.query(
    `insert into raw_inbox (tenant_id, source_id, received_at, body) select $1, $2, $3, b from jsonb_array_elements($4::jsonb) b`,
    [tenant, source.id, now, JSON.stringify(messages)],
  );

  const { rows: known } = await db.query<{ id: string; n: string; properties: Record<string, unknown> }>(
    `select id, lower(name) n, properties from objects where tenant_id = $1 and type_id = $2 and name is not null`,
    [tenant, cropType],
  );
  const crops = new Map<string, Crop>();
  for (const c of known)
    crops.set(c.n, {
      id: c.id,
      hectares: typeof c.properties.hectares === "number" ? c.properties.hectares : null,
      phase: PHASES.includes(c.properties.phase as Phase) ? (c.properties.phase as Phase) : null,
    });

  const crop = async (name: string, area: number | undefined): Promise<Crop> => {
    const hit = crops.get(name.toLowerCase());
    if (hit) return hit;
    const hectares = Math.max(0, ...messages.filter((m) => text(m.subject).toLowerCase() === name.toLowerCase()).map((m) => {
      try { return parseNumber(m.area, "area") ?? 0; } catch { return 0; }
    }), area ?? 0);
    const phase: Phase = register === "harvest" ? "raccolta" : register === "sowing" ? "semina" : "crescita";
    const { rows } = await db.query<{ id: string }>(
      `insert into objects (tenant_id, type_id, name, properties, last_seen) values ($1, $2, $3, $4, $5) returning id`,
      [tenant, cropType, name, { species: name, hectares, phase }, now],
    );
    const c = { id: rows[0].id, hectares, phase };
    crops.set(name.toLowerCase(), c);
    return c;
  };

  const ids = new Set<string>();
  for (const [index, m] of messages.entries()) {
    try {
      const subject = text(m.subject);
      if (!subject) throw new Error("subject is required");
      if (text(m.date) === "") throw new Error("date is required");
      const ts = parseDate(m.date);
      if (ts.getTime() - now.getTime() > 300_000) throw new Error("ts is in the future");
      const area = parseNumber(m.area, "area");
      const dose = parseNumber(m.dose, "dose");
      const quantity = parseNumber(m.quantity, "quantity");
      const c = await crop(subject, area);
      const areaHa = area ?? c.hectares ?? undefined;
      const notes = [text(m.note), text(m.kind)].filter(Boolean).join(" · ");
      const payload: Record<string, unknown> = {};
      if (areaHa !== undefined) payload.area_ha = round(areaHa);
      if (text(m.operator)) payload.operator = text(m.operator);
      if (notes) payload.notes = notes;

      if (register === "treatment") {
        payload.phase = c.phase ?? "crescita";
        payload.product = text(m.product);
        payload.adversity = text(m.adversity) || "non indicata";
        const unit = unitOf(`${text(m.unit)} ${opts.units ?? ""}`) === "L" ? "L" : "kg";
        if (quantity !== undefined) payload.quantity = { value: round(quantity), unit };
        else if (dose !== undefined && areaHa) payload.quantity = { value: round(dose * areaHa), unit };
        else if (payload.product) throw new Error("quantity, or dose and area, is required");
      } else if (register === "harvest") {
        if (quantity !== undefined) {
          const u = unitOf(`${text(m.unit)} ${opts.units ?? ""}`, "kg");
          const q = /\bq/.test(fold(`${text(m.unit)} ${opts.units ?? ""}`)) ? quantity * 100 : quantity;
          payload.yield = { value: round(q), unit: u === "t" ? "t" : "kg" };
        }
      } else if (text(m.product)) payload.variety = text(m.product);

      const err = validateProperties(spec.fields, payload);
      if (err) throw new Error(err);
      const { rows } = await db.query<{ id: string }>(
        `with e as (
           insert into events (tenant_id, ts, type, severity, payload, source_id, recorded_at, author, author_label, document_id)
           values ($1, $2, $3, 'info', $4, $5, $6, $7, $8, $10) returning id
         )
         insert into event_objects (tenant_id, event_id, object_id) select $1, e.id, $9 from e returning event_id`,
        [tenant, ts, `agronomy.${register}`, payload, source.id, now, actor?.id ?? null, actor?.email ?? null, c.id, opts.documentId ?? null],
      );
      if (rows.length) out.events++;
      ids.add(c.id);
      out.accepted++;
    } catch (e) {
      if ((e as { code?: string }).code && !(e as { code?: string }).code!.startsWith("23")) throw e;
      out.rejected.push({ index, error: (e as Error).message });
    }
  }
  out.objectIds = [...ids];
  await db.query(`update sources set last_seen = $2, last_error = $3 where id = $1 and tenant_id = $4`, [
    source.id, now, out.rejected.length ? `${out.rejected.length} rejected: ${out.rejected[0].error}` : null, tenant,
  ]);
  return out;
}

export async function moveLegacyEntries(db: Db, tenantId: string, actor: Actor): Promise<{ moved: number; rejected: number }> {
  const { rows } = await db.query<{ id: string; ts: Date; payload: Record<string, unknown>; subject: string | null; source: Source | null }>(
    `select e.id, e.ts, e.payload, o.name subject,
            (select to_jsonb(s) from (select id, tenant_id, name, connector, module, config, status from sources s where s.id = e.source_id) s) source
     from events e
     left join event_objects eo on eo.tenant_id = e.tenant_id and eo.event_id = e.id
     left join objects o on o.tenant_id = e.tenant_id and o.id = eo.object_id
     where e.tenant_id = $1 and e.type = 'records.entry' and e.document_id is null and e.author is null
     order by e.ts`,
    [tenantId],
  );
  const bySource = new Map<string, typeof rows>();
  for (const r of rows) if (r.source && r.subject) bySource.set(r.source.id, [...(bySource.get(r.source.id) ?? []), r]);
  let moved = 0, rejected = 0;
  for (const group of bySource.values()) {
    const messages = group.map((r) => ({ ...r.payload, kind: undefined, subject: r.subject, date: r.ts.toISOString() }) as RawMessage);
    const register = classify(messages);
    if (!register) continue;
    const out = await importAgronomy(db, group[0].source!, messages, register, actor);
    const ok = group.filter((_, i) => !out.rejected.some((x) => x.index === i)).map((r) => r.id);
    await db.query(`delete from events where tenant_id = $1 and id = any($2::bigint[])`, [tenantId, ok]);
    moved += out.accepted;
    rejected += out.rejected.length;
  }
  return { moved, rejected };
}

export async function countLegacyEntries(db: Db, tenantId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int n from events where tenant_id = $1 and type = 'records.entry' and document_id is null and author is null`,
    [tenantId],
  );
  return rows[0].n;
}
