// The research pipeline's side of the console, through its source token: it reads back its
// project's results with their human reviews (to retrain on them), and the people named on the
// project hear by email or webhook when a run ends or a result scores high enough.
import { forTenant, type Db } from "./engine/db";
import type { Source } from "./engine/sources";
import type { RawMessage } from "./engine/connectors";
import { ConnectorError } from "./engine/connectors";
import { sourceScope, type CustomPushResult } from "./engine/custom-ingest";
import { getObject, getObjectType, searchObjects, type CustomObject } from "./engine/custom-objects";
import { CUSTOM } from "./engine/registers";
import type { Mailer } from "./engine/mail";
import { getSettings } from "./engine/settings";
import { projectFields, RESEARCH, resultFilters } from "./research";

export const RESULTS_PAGE = 1000;
export const RESULTS_MAX = 2000;

export interface ResultsPage {
  total: number;
  offset: number;
  limit: number;
  results: Pick<CustomObject, "id" | "externalId" | "name" | "properties" | "createdAt">[];
}

/** The project a research source writes for, or a ConnectorError saying why there is none. */
async function sourceProject(db: Db, source: Source) {
  if (source.module !== CUSTOM) throw new ConnectorError(403, "source is not for custom types");
  const scope = sourceScope(source);
  if (!scope || scope.link !== RESEARCH.link) throw new ConnectorError(403, "source does not work for a research project");
  const tdb = forTenant(db, source.tenant_id);
  const project = await getObject(tdb, scope.id);
  if (!project || project.type !== RESEARCH.project) throw new ConnectorError(409, "the project this source works for is gone");
  return { tdb, project };
}

/**
 * One page of the source's project results, filtered as on the project page (`review`, `min`,
 * `f.<key>`, `sort`...) and paged with `offset` and `limit` (1000 by default, 2000 at most).
 */
export async function pipelineResults(db: Db, source: Source, sp: URLSearchParams): Promise<ResultsPage> {
  const { tdb, project } = await sourceProject(db, source);
  const resultType = await getObjectType(tdb, RESEARCH.result);
  if (!resultType) throw new ConnectorError(404, "no result type");
  const int = (k: string, fallback: number) => {
    const raw = sp.get(k);
    if (raw === null || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new ConnectorError(400, `"${k}" must be a whole number`);
    return n;
  };
  const limit = Math.min(RESULTS_MAX, Math.max(1, int("limit", RESULTS_PAGE)));
  const offset = int("offset", 0);
  const filters = resultFilters(Object.fromEntries(sp), project.id, { result: resultType.properties, own: projectFields(project) });
  const { objects, total } = await searchObjects(tdb, RESEARCH.result, { ...filters, limit, offset });
  return {
    total,
    offset,
    limit,
    results: objects.map(({ id, externalId, name, properties, createdAt }) => ({ id, externalId, name, properties, createdAt })),
  };
}

export interface PushNews {
  runs: { id: string; key: string; outcome: unknown; items: unknown }[];
  results: { id: string; externalId: string; name: string; score: number }[];
}

/**
 * What a push brought that someone asked to hear of: the runs it created and, when the project
 * has a threshold, the results it created scoring at least that. Sent again, nothing is new.
 */
export function pushNews(messages: RawMessage[], result: CustomPushResult, threshold: number | null): PushNews {
  const news: PushNews = { runs: [], results: [] };
  for (const r of result.results) {
    const m = messages[r.index];
    if (r.status !== "created" || !m) continue;
    if (m.kind === "event" && m.type === RESEARCH.run) {
      const payload = (m.payload ?? {}) as Record<string, unknown>;
      news.runs.push({ id: r.id, key: String(m.key ?? ""), outcome: payload[RESEARCH.outcome] ?? null, items: payload.items ?? null });
    } else if (m.kind === "object" && m.type === RESEARCH.result && threshold !== null) {
      const props = { ...(m.defaults as object), ...(m.properties as object) } as Record<string, unknown>;
      const score = Number(props[RESEARCH.score]);
      if (Number.isFinite(score) && score >= threshold)
        news.results.push({ id: r.id, externalId: String(m.externalId ?? ""), name: String(m.name ?? m.externalId ?? ""), score });
    }
  }
  news.results.sort((a, b) => b.score - a.score);
  return news;
}

export interface NotifyDeps {
  mailer: Mailer | null;
  /** where the console is served, for the links: the push request's origin */
  origin: string;
  fetch?: typeof fetch;
}

const emails = (v: unknown) =>
  typeof v === "string" ? v.split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) : [];

/** An https webhook, or null: the console never posts to plain http. */
const webhook = (v: unknown) => {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
};

/**
 * Tells the project's emails and webhook what a push brought (see pushNews). Run after the
 * response; returns what was sent. A webhook gets `{project, url, runs, results}` as JSON.
 */
export async function notifyPush(db: Db, source: Source, messages: RawMessage[], result: CustomPushResult, deps: NotifyDeps) {
  const sent = { mailed: 0, webhook: false };
  if (!result.accepted) return sent;
  const { tdb, project } = await sourceProject(db, source);
  const to = emails(project.properties[RESEARCH.notifyEmail]);
  const hook = webhook(project.properties[RESEARCH.notifyWebhook]);
  if (!to.length && !hook) return sent;
  const raw = project.properties[RESEARCH.notifyScore];
  const threshold = raw == null || raw === "" || !Number.isFinite(Number(raw)) ? null : Number(raw);
  const news = pushNews(messages, result, threshold);
  if (!news.runs.length && !news.results.length) return sent;

  const { rows } = await tdb.query<{ slug: string }>(
    `select g.slug from sources s join organizations g on g.id = s.tenant_id where s.tenant_id = $1 and s.id = $2`,
    [tdb.tenantId, source.id],
  );
  const url = rows[0] ? `${deps.origin}/research/o/${rows[0].slug}/p/${project.id}` : null;
  const errors: string[] = [];
  if (hook) {
    try {
      const res = await (deps.fetch ?? fetch)(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: { id: project.id, name: project.name }, url, ...news }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`webhook answered ${res.status}`);
      sent.webhook = true;
    } catch (e) {
      errors.push(`webhook: ${(e as Error).message}`);
    }
  }
  if (to.length && deps.mailer) {
    try {
      const from = String((await getSettings(db, true))["alerts.email_from"]);
      await deps.mailer.send({ from, to, ...newsMail(project.name, news, url) });
      sent.mailed = to.length;
    } catch (e) {
      errors.push(`mail: ${(e as Error).message}`);
    }
  }
  if (errors.length) throw new Error(`research notification for ${project.id}: ${errors.join("; ")}`);
  return sent;
}

export function newsMail(project: string, news: PushNews, url: string | null): { subject: string; text: string } {
  const lines: string[] = [];
  if (news.runs.length)
    lines.push("Runs:", ...news.runs.map((r) => `  - ${r.key || r.id}: ${r.outcome ?? "?"}${r.items != null ? `, ${r.items} items` : ""}`), "");
  if (news.results.length) {
    lines.push("New results above the threshold:", ...news.results.slice(0, 20).map((r) => `  - ${r.name} (${r.externalId}): ${r.score}`));
    if (news.results.length > 20) lines.push(`  ... and ${news.results.length - 20} more`);
    lines.push("");
  }
  if (url) lines.push(url);
  const what = [
    news.runs.length && `${news.runs.length} run${news.runs.length > 1 ? "s" : ""}`,
    news.results.length && `${news.results.length} high-scoring result${news.results.length > 1 ? "s" : ""}`,
  ].filter(Boolean);
  return { subject: `[VDX Research] ${project}: ${what.join(", ")}`, text: lines.join("\n") };
}
