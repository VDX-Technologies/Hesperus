/**
 * POST /api/push - generic push ingestion.
 * Auth: "Authorization: Bearer <source token>". Body: one message or an array of messages,
 * interpreted by the source's module package. A source of the tenant's own types (module
 * "custom") also takes a CSV of objects: "Content-Type: text/csv" and "?type=<object type>".
 */
import { crossTenantAccess, crossTenantDb } from "@/lib/engine/db";
import { ConnectorError, pushConnector } from "@/lib/engine/connectors";
import { csvMessages, ingestCustom } from "@/lib/engine/custom-ingest";
import { ingestPush, takeIngestToken } from "@/lib/engine/ingest";
import { CUSTOM } from "@/lib/engine/registers";
import { ValidationError } from "@/lib/engine/package";
import { markSeen, sourceByToken } from "@/lib/engine/sources";
import { getPackage } from "@/lib/packages";
import { after } from "next/server";
import { mailerFromEnv } from "@/lib/engine/mail";
import { notifyPush } from "@/lib/research-pipeline";

const MAX_BODY = 4_000_000; // Vercel caps function bodies at 4.5 MB anyway

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return Response.json({ error: "missing source token" }, { status: 401 });

  const db = crossTenantDb(crossTenantAccess.ingest);
  const source = await sourceByToken(db, token);
  if (!source) return Response.json({ error: "invalid source token" }, { status: 401 });
  if (source.connector !== "push") return Response.json({ error: "source does not accept push" }, { status: 403 });
  if (source.status === "paused") return Response.json({ error: "source is paused" }, { status: 403 });
  const custom = source.module === CUSTOM;
  const pkg = custom ? null : getPackage(source.module);
  if (!custom && !pkg) return Response.json({ error: `module "${source.module}" is not installed` }, { status: 500 });

  const wait = await takeIngestToken(db, source.id);
  if (wait > 0)
    return Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(wait)) } });

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error: "body too large" }, { status: 413 });
  const csv = custom && /^text\/csv\b/i.test(request.headers.get("content-type") ?? "");
  let text: string;
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "invalid JSON" }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => undefined);
        return Response.json({ error: "body too large" }, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(bytes);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  let body: unknown;
  if (!csv) {
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
  }
  try {
    if (custom) {
      const messages = csv
        ? await csvMessages(db, source, new URL(request.url).searchParams.get("type") ?? "", text)
        : await pushConnector.messages(source, body);
      const result = await ingestCustom(db, source, messages);
      // a research project's emails and webhook hear of new runs and high scores, after the answer
      after(() =>
        notifyPush(db, source, messages, result, { mailer: mailerFromEnv(), origin: new URL(request.url).origin }).catch((e) => {
          if (!(e instanceof ConnectorError)) console.error(e);
        }),
      );
      return Response.json(result, { status: result.rejected.length && !result.accepted ? 422 : 200 });
    }
    const result = await ingestPush(db, source, await pushConnector.messages(source, body), pkg!);
    return Response.json(result, { status: result.rejected.length && !result.accepted ? 422 : 200 });
  } catch (e) {
    const status = e instanceof ConnectorError ? e.status : e instanceof ValidationError || e instanceof RangeError ? 400 : null;
    if (status === null) throw e;
    const error = (e as Error).message;
    // a refused batch shows on the project page of a custom source, next to its last push
    if (custom) await markSeen(db, source, error).catch(() => undefined);
    return Response.json({ error }, { status });
  }
}
