// Sources and their push tokens. Only the sha256 of a token is stored; the token itself is
// shown once when the source is created.
import { createHash, randomBytes } from "node:crypto";
import type { Db, TenantDb } from "./db";
import type { ConnectorKind } from "./connectors";

export interface Source {
  id: string;
  tenant_id: string;
  name: string;
  connector: ConnectorKind;
  module: string;
  config: Record<string, unknown>;
  status: "active" | "paused" | "error";
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const newToken = () => `vdx_${randomBytes(24).toString("base64url")}`;

export async function createSource(
  db: Db,
  s: { tenantId: string; name: string; module: string; connector?: ConnectorKind; config?: Record<string, unknown> },
): Promise<{ source: Source; token: string }> {
  const token = newToken();
  const { rows } = await db.query<Source>(
    `insert into sources (tenant_id, name, connector, module, config, token_hash, token_hint)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id, tenant_id, name, connector, module, config, status`,
    [s.tenantId, s.name, s.connector ?? "push", s.module, s.config ?? {}, hashToken(token), token.slice(-4)],
  );
  return { source: rows[0], token };
}

export async function sourceByToken(db: Db, token: string): Promise<Source | null> {
  const { rows } = await db.query<Source>(
    `select id, tenant_id, name, connector, module, config, status from sources where token_hash = $1`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

/** Replaces a source's token; the old one stops working at once. Returns the new token. */
export async function rotateToken(db: Db, sourceId: string): Promise<string> {
  const token = newToken();
  const { rowCount } = await db.query(`update sources set token_hash = $2, token_hint = $3 where id = $1`, [
    sourceId, hashToken(token), token.slice(-4),
  ]);
  if (!rowCount) throw new Error(`no source ${sourceId}`);
  return token;
}

/**
 * Deletes the push token of one source, or of every source of the organization when no source is
 * given: pushes with it are refused at once, the source and its data stay. Returns how many went.
 */
export async function revokeTokens(db: Db, tenantId: string, sourceId?: string): Promise<number> {
  const { rowCount } = await db.query(
    `update sources set token_hash = null, token_hint = null
     where tenant_id = $1 and ($2::uuid is null or id = $2) and token_hash is not null`,
    [tenantId, sourceId ?? null],
  );
  return rowCount ?? 0;
}

/** Notes that a source sent something: when, and what went wrong (null when nothing did). */
export async function markSeen(db: Db, source: Source, error: string | null, now = new Date()): Promise<void> {
  await db.query(`update sources set last_seen = $2, last_error = $3 where id = $1 and tenant_id = $4`, [
    source.id, now, error?.slice(0, 500) ?? null, source.tenant_id,
  ]);
}

export interface SourceState {
  id: string;
  name: string;
  status: Source["status"];
  /** The last four characters of the token, null once it was deleted. */
  tokenHint: string | null;
  lastSeen: Date | null;
  lastError: string | null;
  createdAt: Date;
}

/** The push sources bound to one object (sources.config.scope.id): a project's pipelines. */
export async function scopedSources(db: TenantDb, objectId: string): Promise<SourceState[]> {
  const { rows } = await db.query<{ id: string; name: string; status: Source["status"]; token_hint: string | null; last_seen: Date | null; last_error: string | null; created_at: Date }>(
    `select id, name, status, token_hint, last_seen, last_error, created_at from sources
     where tenant_id = $1 and connector = 'push' and config->'scope'->>'id' = $2 order by name`,
    [db.tenantId, objectId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, tokenHint: r.token_hint, lastSeen: r.last_seen, lastError: r.last_error, createdAt: r.created_at }));
}
