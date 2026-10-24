// The Research console reads the types made in the schema editor (scripts/research/types.ts is
// their versioned copy). Only the names of those types and properties live here: the engine
// knows nothing of projects or results, and another sector can point a console at its own types.
import { parseDecimal, type Schema } from "./engine/schema";
import type { PropertySpec } from "./engine/package";
import type { CustomObject, ObjectSearch } from "./engine/custom-objects";
import { csvCell, dec } from "./engine/registers";

export const RESEARCH = {
  project: "custom.project",
  result: "custom.result",
  run: "custom.run",
  /** the result → project link */
  link: "project",
  stage: "stage",
  score: "score",
  review: "review",
  /** the review value of a result nobody has looked at yet */
  pending: "to_review",
  outcome: "outcome",
  note: "note",
  /** the project property holding its results' own fields, and the result property following it */
  schema: "result_schema",
  extra: "extra",
  /** the email of the member a result is assigned to; without it the console hides assignment */
  assignee: "assignee",
} as const;

/** The review values a key sets in the review queue. */
export const REVIEW_KEYS: Record<string, string> = { i: "interesting", d: "discarded", s: "sent" };

type Query = Record<string, string | string[] | undefined>;

/** The query parameters that filter or sort results, so a link can keep them (not the page). */
export const isFilterParam = (k: string) =>
  ["q", "review", "min", "max", "mine", "sort", "order"].includes(k) || /^(f|min|max)\.[\w.]+$/.test(k);

export function filterQuery(sp: Query): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v.trim() && isFilterParam(k)) q.set(k, v.trim());
  return q;
}

/** The schemas the filters are read against: the result type's, the project's own fields, and who is asking. */
export interface FilterContext {
  result?: Schema;
  own?: Schema;
  me?: string | null;
}

const specAt = (key: string, c: FilterContext): PropertySpec | undefined => {
  const [top, sub, ...rest] = key.split(".");
  if (rest.length) return undefined;
  return sub === undefined ? c.result?.[top] : top === RESEARCH.extra ? c.own?.[sub] : undefined;
};

// a filter value as the property stores it; undefined when it cannot be one
const typed = (spec: PropertySpec | undefined, raw: string): unknown => {
  if (spec?.type === "integer" || spec?.type === "number") return parseDecimal(raw) ?? undefined;
  if (spec?.type === "boolean") return raw === "true" ? true : raw === "false" ? false : undefined;
  return raw;
};

/**
 * The results filter of a project page, read from its query string: `q` searches name and
 * external id, `f.<key>` asks for a value, `min.<key>` / `max.<key>` bound a number (`min` and
 * `max` alone bound the score), `mine=1` keeps the results assigned to `me`, and `sort` / `order`
 * sort (score, highest first, by default). `<key>` can be `extra.<field>` for the project's fields.
 */
export function resultFilters(sp: Query, project: string, c: FilterContext = {}): ObjectSearch & { page: number } {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");
  const where: Record<string, unknown> = {};
  const min: Record<string, number> = {}, max: Record<string, number> = {};
  if (one("review")) where[RESEARCH.review] = one("review");
  if (one("mine") && c.me) where[RESEARCH.assignee] = c.me;
  const bound = (into: Record<string, number>, key: string, raw: string) => {
    const n = raw ? parseDecimal(raw) : null;
    if (n !== null) into[key] = n;
  };
  bound(min, RESEARCH.score, one("min"));
  bound(max, RESEARCH.score, one("max"));
  for (const k of Object.keys(sp)) {
    const m = /^(f|min|max)\.([\w.]+)$/.exec(k);
    if (!m || !one(k)) continue;
    if (m[1] === "f") {
      const v = typed(specAt(m[2], c), one(k));
      if (v !== undefined) where[m[2]] = v;
    } else bound(m[1] === "min" ? min : max, m[2], one(k));
  }
  const some = <T extends object>(o: T) => (Object.keys(o).length ? o : undefined);
  const page = Math.max(1, Math.floor(Number(one("page")) || 1));
  return {
    linkedTo: { key: RESEARCH.link, id: project },
    text: one("q") || undefined,
    where: some(where),
    min: some(min),
    max: some(max),
    order: { by: one("sort") || RESEARCH.score, desc: one("order") !== "asc" },
    schemas: c.own ? { [RESEARCH.extra]: c.own } : undefined,
    page,
  };
}

/**
 * The fields a batch change makes on one result, only those that differ: an empty value leaves a
 * field as it is, an assignee of "-" removes it.
 */
export function batchPatch(o: CustomObject, change: { review?: string; assignee?: string }): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (change.review && change.review !== o.properties[RESEARCH.review]) patch[RESEARCH.review] = change.review;
  const who = change.assignee?.trim();
  if (who === "-") {
    if (o.properties[RESEARCH.assignee] != null) patch[RESEARCH.assignee] = null;
  } else if (who && who !== o.properties[RESEARCH.assignee]) patch[RESEARCH.assignee] = who;
  return Object.keys(patch).length ? patch : null;
}

/** The fields a review changes, only those that differ; an emptied note is removed. */
export function reviewPatch(o: CustomObject, review: string, note: string): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (review && review !== o.properties[RESEARCH.review]) patch[RESEARCH.review] = review;
  const text = note.trim();
  if (text !== String(o.properties[RESEARCH.note] ?? "")) patch[RESEARCH.note] = text || null;
  return Object.keys(patch).length ? patch : null;
}

// a scalar the way the CSV writes it: comma decimals, objects as JSON
const csvValue = (s: PropertySpec | undefined, v: unknown) =>
  v === undefined || v === null ? "" : s?.type === "number" || s?.type === "integer" ? dec(v)
    : typeof v === "object" ? JSON.stringify(v) : String(v);

/**
 * The CSV of a project's results: keys, not labels, for whoever reads it; the result type's
 * fields, then the project's own as `extra.<key>`. `header` starts with a BOM for spreadsheets.
 */
export function resultsCsv(result: Schema, own: Schema) {
  const fields = Object.entries(result).filter(([k, s]) => s.type !== "object" && k !== RESEARCH.extra);
  const extra = Object.entries(own);
  return {
    header: "\uFEFF" + ["id", "external_id", "name", ...fields.map(([k]) => k), ...extra.map(([k]) => `${RESEARCH.extra}.${k}`), "created_at"].join(";") + "\r\n",
    line: (o: CustomObject) => {
      const x = (o.properties[RESEARCH.extra] ?? {}) as Record<string, unknown>;
      return [
        o.id, o.externalId ?? "", o.name, ...fields.map(([k, s]) => csvValue(s, o.properties[k])),
        ...extra.map(([k, s]) => csvValue(s, x[k])), o.createdAt.toISOString(),
      ].map(csvCell).join(";") + "\r\n";
    },
  };
}

/** The project's own result fields (TIC id, gene...), shown as columns of its results. */
export function projectFields(project: CustomObject): Schema {
  const s = project.properties[RESEARCH.schema];
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Schema) : {};
}

// raster images only: an SVG can carry script, so it is downloaded and never shown inline
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const inlineImage = (contentType: string | null) => !!contentType && IMAGES.has(contentType.toLowerCase().split(";")[0].trim());
