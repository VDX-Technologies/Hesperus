import { parseDecimal, type Schema } from "./engine/schema";
import type { PropertySpec } from "./engine/package";
import type { CustomObject, ObjectSearch } from "./engine/custom-objects";
import { csvCell, dec } from "./engine/registers";
import { parseCsv } from "./engine/csv";

export const RESEARCH = {
  project: "custom.project",
  result: "custom.result",
  run: "custom.run",
  dataset: "custom.dataset",
  labNote: "custom.lab_note",
  comment: "custom.comment",
  view: "custom.view",
  query: "query",
  link: "project",
  stage: "stage",
  score: "score",
  review: "review",
  pending: "to_review",
  outcome: "outcome",
  note: "note",
  schema: "result_schema",
  extra: "extra",
  assignee: "assignee",
  runRef: "run",
  links: "result_links",
  text: "text",
  replyTo: "reply_to",
  notifyEmail: "notify_email",
  notifyWebhook: "notify_webhook",
  notifyScore: "notify_score",
} as const;

export const REVIEW_KEYS: Record<string, string> = { i: "interesting", d: "discarded", s: "sent" };

type Query = Record<string, string | string[] | undefined>;

export const isFilterParam = (k: string) =>
  ["q", "review", "min", "max", "mine", "sort", "order", "cols", "hist", "x", "y"].includes(k) || /^(f|min|max)\.[\w.]+$/.test(k);

export function filterQuery(sp: Query): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, raw] of Object.entries(sp)) {
    const v = k === "cols" && Array.isArray(raw) ? raw.join(",") : raw;
    if (typeof v === "string" && v.trim() && isFilterParam(k)) q.set(k, v.trim());
  }
  return q;
}

export function shownColumns(cols: unknown, all: string[]): Set<string> {
  const raw = Array.isArray(cols) ? cols.join(",") : cols;
  const asked = typeof raw === "string" ? raw.split(",").map((c) => c.trim()).filter((c) => all.includes(c)) : [];
  return new Set(asked.length ? asked : all);
}

export function viewQuery(raw: string): string {
  const sp: Query = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    const had = sp[k];
    sp[k] = had === undefined ? v : [...(Array.isArray(had) ? had : [had]), v];
  }
  return filterQuery(sp).toString();
}

export const VISIT_COOKIE = "research_visit";

const VISIT = 30 * 60_000;

export function lastVisit(cookie: string | undefined, now: number): { since: Date | null; next: string | null } {
  const [prev, latest] = (cookie ?? "").split("|").map((v) => (/^\d+$/.test(v) ? Number(v) : null));
  if (!latest || latest > now) return { since: null, next: `|${now}` };
  if (now - latest > VISIT) return { since: new Date(latest), next: `${latest}|${now}` };
  return { since: prev ? new Date(prev) : null, next: null };
}

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

const typed = (spec: PropertySpec | undefined, raw: string): unknown => {
  if (spec?.type === "integer" || spec?.type === "number") return parseDecimal(raw) ?? undefined;
  if (spec?.type === "boolean") return raw === "true" ? true : raw === "false" ? false : undefined;
  return raw;
};

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

export function batchPatch(o: CustomObject, change: { review?: string; assignee?: string }): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (change.review && change.review !== o.properties[RESEARCH.review]) patch[RESEARCH.review] = change.review;
  const who = change.assignee?.trim();
  if (who === "-") {
    if (o.properties[RESEARCH.assignee] != null) patch[RESEARCH.assignee] = null;
  } else if (who && who !== o.properties[RESEARCH.assignee]) patch[RESEARCH.assignee] = who;
  return Object.keys(patch).length ? patch : null;
}

export function reviewPatch(o: CustomObject, review: string, note: string): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (review && review !== o.properties[RESEARCH.review]) patch[RESEARCH.review] = review;
  const text = note.trim();
  if (text !== String(o.properties[RESEARCH.note] ?? "")) patch[RESEARCH.note] = text || null;
  return Object.keys(patch).length ? patch : null;
}

const csvValue = (s: PropertySpec | undefined, v: unknown) =>
  v === undefined || v === null ? "" : s?.type === "number" || s?.type === "integer" ? dec(v)
    : typeof v === "object" ? JSON.stringify(v) : String(v);

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

export function projectFields(project: CustomObject): Schema {
  const s = project.properties[RESEARCH.schema];
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Schema) : {};
}

const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const inlineImage = (contentType: string | null) => !!contentType && IMAGES.has(contentType.toLowerCase().split(";")[0].trim());

export interface OutsideLink {
  label: string;
  url: string;
}

const LINE = /^(.*?)\s*(https?:\/\/\S+)$/i;

export function expandLinks(template: unknown, o: CustomObject): OutsideLink[] {
  if (typeof template !== "string") return [];
  const extra = (o.properties[RESEARCH.extra] ?? {}) as Record<string, unknown>;
  const value = (k: string): unknown =>
    k === "name" ? o.name : k === "external_id" ? o.externalId : k === "id" ? o.id : k in o.properties ? o.properties[k] : extra[k];
  const out: OutsideLink[] = [];
  for (const line of template.split(/\r?\n/)) {
    const m = LINE.exec(line.trim());
    if (!m || out.length >= 20) continue;
    let missing = false;
    const url = m[2].replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = value(k);
      if (v === null || v === undefined || v === "" || typeof v === "object") missing = true;
      return missing ? "" : encodeURIComponent(String(v));
    });
    if (missing) continue;
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") out.push({ label: m[1] || u.hostname, url: u.toString() });
    } catch {
    }
  }
  return out;
}

export interface ParamRow {
  key: string;
  a: unknown;
  b: unknown;
  state: "same" | "changed" | "onlyA" | "onlyB";
}

function leaves(v: unknown, prefix: string, into: Map<string, unknown>) {
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) {
    for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, into);
  } else if (prefix) into.set(prefix, v);
}

export function paramDiff(a: unknown, b: unknown): ParamRow[] {
  const la = new Map<string, unknown>(), lb = new Map<string, unknown>();
  leaves(a, "", la);
  leaves(b, "", lb);
  const rows = [...new Set([...la.keys(), ...lb.keys()])].map((key): ParamRow => {
    const state = !lb.has(key) ? "onlyA" : !la.has(key) ? "onlyB" : JSON.stringify(la.get(key)) === JSON.stringify(lb.get(key)) ? "same" : "changed";
    return { key, a: la.get(key), b: lb.get(key), state };
  });
  return rows.sort((x, y) => Number(x.state === "same") - Number(y.state === "same") || x.key.localeCompare(y.key));
}

export function commentThreads<T extends { rootId: number; ts: Date; payload: Record<string, unknown> }>(list: T[]): { comment: T; replies: T[] }[] {
  const byId = new Map(list.map((c) => [c.rootId, c]));
  const top = (c: T): T => {
    const seen = new Set<number>();
    for (let p = byId.get(Number(c.payload[RESEARCH.replyTo])); p && !seen.has(p.rootId); p = byId.get(Number(p.payload[RESEARCH.replyTo]))) {
      seen.add(p.rootId);
      c = p;
    }
    return c;
  };
  const sorted = [...list].sort((x, y) => x.ts.getTime() - y.ts.getTime() || x.rootId - y.rootId);
  const threads = new Map<number, { comment: T; replies: T[] }>();
  for (const c of sorted) {
    const root = top(c);
    if (root === c) threads.set(c.rootId, { comment: c, replies: threads.get(c.rootId)?.replies ?? [] });
    else {
      const t = threads.get(root.rootId) ?? { comment: root, replies: [] };
      t.replies.push(c);
      threads.set(root.rootId, t);
    }
  }
  return [...threads.values()];
}

export function csvPreview(bytes: Uint8Array, maxRows = 20, maxBytes = 16384): { headers: string[]; rows: string[][]; more: boolean } | null {
  const cut = bytes.length > maxBytes;
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
  if (cut) text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  try {
    const csv = parseCsv(text, Infinity, 200);
    if (!csv.headers.length) return null;
    return { headers: csv.headers, rows: csv.rows.slice(0, maxRows), more: cut || csv.rows.length > maxRows };
  } catch {
    return null;
  }
}

export const isCsv = (contentType: string | null, filename: string | null) =>
  /^text\/(csv|tab-separated-values)\b/i.test(contentType ?? "") || /\.(csv|tsv)$/i.test(filename ?? "");

export const isPdf = (contentType: string | null) => /^application\/pdf\b/i.test(contentType ?? "");
