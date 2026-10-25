// The request side of the source token endpoints: bearer token, scope, status and rate limit in one
// place, and a body reader that stops at a size limit even without a content-length.
import { crossTenantAccess, crossTenantDb, type Db } from "./db";
import { takeIngestToken } from "./ingest";
import { sourceByToken, type Source, type TokenScope } from "./sources";

/** The client address as the platform's proxy reports it. */
export function clientIp(request: Request): string | null {
  return request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null;
}

/**
 * The source behind the request's token, if it has the scope, is active and passes `accept`
 * (an error message to refuse with 403) and the source's rate limit; otherwise the response to send.
 */
export async function authSource(
  request: Request, scope: TokenScope, accept: (source: Source) => string | null = () => null,
): Promise<{ db: Db; source: Source } | { error: Response }> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return { error: Response.json({ error: "missing source token" }, { status: 401 }) };
  const db = crossTenantDb(crossTenantAccess.ingest);
  // a malformed token is refused by sourceByToken before any query
  const source = await sourceByToken(db, token, scope, clientIp(request));
  if (!source) return { error: Response.json({ error: "invalid source token" }, { status: 401 }) };
  const refused = accept(source);
  if (refused) return { error: Response.json({ error: refused }, { status: 403 }) };
  if (source.status === "paused") return { error: Response.json({ error: "source is paused" }, { status: 403 }) };
  const wait = await takeIngestToken(db, source.id);
  if (wait > 0)
    return { error: Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(Math.ceil(wait)) } }) };
  return { db, source };
}

/** The request body, or a 413 once it passes max bytes (content-length is only a first check). */
export async function readBody(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | Response> {
  const tooLarge = () => Response.json({ error: "body too large" }, { status: 413 });
  if (Number(request.headers.get("content-length") ?? 0) > max) return tooLarge();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
