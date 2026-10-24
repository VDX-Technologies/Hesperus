// The Research console reads the types made in the schema editor (scripts/research/types.ts is
// their versioned copy). Only the names of those types and properties live here: the engine
// knows nothing of projects or results, and another sector can point a console at its own types.
import type { Schema } from "./engine/schema";
import type { CustomObject, ObjectSearch } from "./engine/custom-objects";

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
} as const;

/** The results filter of a project page, read from its query string. */
export function resultFilters(sp: Record<string, string | string[] | undefined>, project: string): ObjectSearch & { page: number } {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");
  const bound = (k: string) => {
    const n = Number(one(k).replace(",", "."));
    return one(k) && Number.isFinite(n) ? { [RESEARCH.score]: n } : undefined;
  };
  const page = Math.max(1, Math.floor(Number(one("page")) || 1));
  return {
    linkedTo: { key: RESEARCH.link, id: project },
    where: one("review") ? { [RESEARCH.review]: one("review") } : undefined,
    min: bound("min"),
    max: bound("max"),
    order: { by: RESEARCH.score, desc: one("order") !== "asc" },
    page,
  };
}

/** The fields a review changes, only those that differ; an emptied note is removed. */
export function reviewPatch(o: CustomObject, review: string, note: string): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (review && review !== o.properties[RESEARCH.review]) patch[RESEARCH.review] = review;
  const text = note.trim();
  if (text !== String(o.properties[RESEARCH.note] ?? "")) patch[RESEARCH.note] = text || null;
  return Object.keys(patch).length ? patch : null;
}

/** The project's own result fields (TIC id, gene...), shown as columns of its results. */
export function projectFields(project: CustomObject): Schema {
  const s = project.properties[RESEARCH.schema];
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Schema) : {};
}

// raster images only: an SVG can carry script, so it is downloaded and never shown inline
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const inlineImage = (contentType: string | null) => !!contentType && IMAGES.has(contentType.toLowerCase().split(";")[0].trim());
