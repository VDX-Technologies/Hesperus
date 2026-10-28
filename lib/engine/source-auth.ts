import { crossTenantAccess, crossTenantDb, type Db } from "./db";
import { takeIngestToken } from "./ingest";
import { sourceByToken, type Source, type TokenScope } from "./sources";

export function clientIp(request: Request): string | null {
  return request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null;
}

export async function authSource(
  request: Request, scope: TokenScope, accept: (source: Source) => string | null = () => null,
): Promise<{ db: Db; source: Source } | { error: Response }> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return { error: Response.json({ error: "missing source token" }, { status: 401 }) };
  const db = crossTenantDb(crossTenantAccess.ingest);
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
