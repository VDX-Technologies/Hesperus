// The research pipeline's side of the console, through its source token: it reads back its
// project's results with their human reviews (to retrain on them), and the people named on the
// project hear by email or webhook when a run ends or a result scores high enough.
import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
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
  /** the addresses a host name resolves to (node:dns by default) */
  lookup?: (host: string) => Promise<string[]>;
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

// addresses a webhook may not reach: this network, loopback, private, CGNAT, link-local (cloud
// metadata), benchmarking, multicast and reserved; IPv6 loopback, unspecified, ULA, link-local,
// multicast, and IPv4-mapped/NAT64 forms of the IPv4 ranges
const PRIVATE = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(net, bits, "ipv6");

/** Whether an address is one a webhook may not reach (IPv4-mapped and NAT64 forms checked as IPv4). */
export function privateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, "ipv4");
  if (family !== 6) return true;
  const v6 = address.toLowerCase();
  const embedded = v6.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embedded) return PRIVATE.check(embedded, "ipv4");
  const hex = v6.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return PRIVATE.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
  }
  return PRIVATE.check(address, "ipv6");
}

const resolveAll = async (host: string) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Refuses a webhook whose host is, or resolves to, a private address. Checked just before the
 * post; a DNS answer changing between this check and the connection is not covered (pinning the
 * address needs a custom dispatcher), and redirects are refused by the post itself.
 */
async function publicHost(url: string, lookup: (host: string) => Promise<string[]>) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await lookup(host);
  if (!addresses.length || addresses.some(privateAddress)) throw new Error("webhook host is not a public address");
}

/**
 * The key a project's webhook posts are signed with: derived from RESEARCH_WEBHOOK_SECRET and the
 * project id, so each project has its own and none is stored. Null when the secret is not set.
 */
export function webhookSecret(projectId: string): string | null {
  const root = process.env.RESEARCH_WEBHOOK_SECRET;
  return root ? createHmac("sha256", root).update(`research-webhook:${projectId}`).digest("hex") : null;
}

/** Signature headers for a webhook body: HMAC-SHA256 of `<timestamp>.<body>` with the project's key. */
export function webhookSignature(projectId: string, body: string, now = Date.now()): Record<string, string> {
  const secret = webhookSecret(projectId);
  if (!secret) return {};
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { "x-vdx-timestamp": timestamp, "x-vdx-signature": `sha256=${signature}` };
}

/**
 * Tells the project's emails and webhook what a push brought (see pushNews). Run after the
 * response; returns what was sent. A webhook gets `{project, url, runs, results}` as JSON, signed
 * (X-VDX-Signature, X-VDX-Timestamp: see webhookSignature) when RESEARCH_WEBHOOK_SECRET is set,
 * and only when its host is a public address.
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
      await publicHost(hook, deps.lookup ?? resolveAll);
      const body = JSON.stringify({ project: { id: project.id, name: project.name }, url, ...news });
      const res = await (deps.fetch ?? fetch)(hook, {
        method: "POST",
        headers: { "content-type": "application/json", ...webhookSignature(project.id, body) },
        body,
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
