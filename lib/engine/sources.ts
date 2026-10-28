import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
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

export const TOKEN_FORMAT = /^vdx_[A-Za-z0-9_-]{32}$/;

export type TokenScope = "write" | "documents" | "read";
export const TOKEN_SCOPES: readonly TokenScope[] = ["write", "documents", "read"];

const SOURCE_COLUMNS = "s.id, s.tenant_id, s.name, s.connector, s.module, s.config, s.status";

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

export async function sourceByToken(db: Db, token: string, scope?: TokenScope, ip?: string | null): Promise<Source | null> {
  if (!TOKEN_FORMAT.test(token)) return null;
  const hash = hashToken(token);
  const address = ip && isIP(ip) ? ip : null;
  const primary = await db.query<Source>(`select ${SOURCE_COLUMNS} from sources s where s.token_hash = $1`, [hash]);
  if (primary.rows[0]) {
    if (address)
      await db.query(`update sources set last_used_ip = $2 where id = $1 and last_used_ip is distinct from $2::inet`, [primary.rows[0].id, address]);
    return primary.rows[0];
  }
  const { rows } = await db.query<Source>(
    `with t as (
       update source_tokens set last_used_at = now(), last_used_ip = coalesce($3::inet, last_used_ip)
       where token_hash = $1 and (expires_at is null or expires_at > now()) and ($2::text is null or $2 = any(scopes))
       returning source_id)
     select ${SOURCE_COLUMNS} from sources s join t on t.source_id = s.id`,
    [hash, scope ?? null, address],
  );
  return rows[0] ?? null;
}

export async function rotateToken(db: TenantDb, sourceId: string, graceSeconds = 0): Promise<string> {
  const token = newToken();
  const { rows } = await db.query<{ old_hash: string | null; old_hint: string | null }>(
    `update sources s set token_hash = $3, token_hint = $4 from sources o
     where s.tenant_id = $1 and s.id = $2 and o.id = s.id
     returning o.token_hash old_hash, o.token_hint old_hint`,
    [db.tenantId, sourceId, hashToken(token), token.slice(-4)],
  );
  if (!rows[0]) throw new Error(`no source ${sourceId}`);
  if (graceSeconds > 0 && rows[0].old_hash)
    await db.query(
      `insert into source_tokens (tenant_id, source_id, token_hash, token_hint, scopes, expires_at)
       values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
      [db.tenantId, sourceId, rows[0].old_hash, rows[0].old_hint ?? "", TOKEN_SCOPES, graceSeconds],
    );
  return token;
}

export async function createToken(
  db: TenantDb, sourceId: string, t: { scopes: TokenScope[]; expiresAt?: Date | null },
): Promise<{ id: string; token: string }> {
  const scopes = [...new Set(t.scopes)].filter((x) => TOKEN_SCOPES.includes(x));
  if (!scopes.length) throw new Error("a token needs at least one scope");
  const token = newToken();
  const { rows } = await db.query<{ id: string }>(
    `insert into source_tokens (tenant_id, source_id, token_hash, token_hint, scopes, expires_at)
     select $1, s.id, $3, $4, $5, $6 from sources s where s.tenant_id = $1 and s.id = $2
     returning id`,
    [db.tenantId, sourceId, hashToken(token), token.slice(-4), scopes, t.expiresAt ?? null],
  );
  if (!rows[0]) throw new Error(`no source ${sourceId}`);
  return { id: rows[0].id, token };
}

export interface ExtraToken {
  id: string;
  hint: string;
  scopes: TokenScope[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
}

export async function sourceTokens(db: TenantDb, sourceId: string): Promise<ExtraToken[]> {
  const { rows } = await db.query<{ id: string; token_hint: string; scopes: TokenScope[]; expires_at: Date | null; last_used_at: Date | null; last_used_ip: string | null }>(
    `select id, token_hint, scopes, expires_at, last_used_at, host(last_used_ip) last_used_ip from source_tokens
     where tenant_id = $1 and source_id = $2 order by created_at`,
    [db.tenantId, sourceId],
  );
  return rows.map((r) => ({ id: r.id, hint: r.token_hint, scopes: r.scopes, expiresAt: r.expires_at, lastUsedAt: r.last_used_at, lastUsedIp: r.last_used_ip }));
}

export async function revokeTokens(db: Db, tenantId: string, sourceId?: string): Promise<number> {
  const { rowCount } = await db.query(
    `update sources set token_hash = null, token_hint = null
     where tenant_id = $1 and ($2::uuid is null or id = $2) and token_hash is not null`,
    [tenantId, sourceId ?? null],
  );
  const extra = await db.query(
    `delete from source_tokens where tenant_id = $1 and ($2::uuid is null or source_id = $2)`,
    [tenantId, sourceId ?? null],
  );
  return (rowCount ?? 0) + (extra.rowCount ?? 0);
}

export async function deleteToken(db: TenantDb, tokenId: string): Promise<boolean> {
  const { rowCount } = await db.query(`delete from source_tokens where tenant_id = $1 and id = $2`, [db.tenantId, tokenId]);
  return !!rowCount;
}

const KEPT_ERRORS = 50;

export async function markSeen(db: Db, source: Source, error: string | null, now = new Date()): Promise<void> {
  await db.query(`update sources set last_seen = $2, last_error = $3 where id = $1 and tenant_id = $4`, [
    source.id, now, error?.slice(0, 500) ?? null, source.tenant_id,
  ]);
  if (!error) return;
  await db.query(
    `with added as (
       insert into source_errors (tenant_id, source_id, at, error) values ($1, $2, $3, $4) returning id
     )
     delete from source_errors where tenant_id = $1 and source_id = $2 and id not in (
       select id from source_errors where tenant_id = $1 and source_id = $2 order by at desc, id desc limit $5
     )`,
    [source.tenant_id, source.id, now, error.slice(0, 4000), KEPT_ERRORS - 1],
  );
}

export async function sourceErrors(db: TenantDb, sourceId: string, limit = KEPT_ERRORS): Promise<{ at: Date; error: string }[]> {
  const { rows } = await db.query<{ at: Date; error: string }>(
    `select at, error from source_errors where tenant_id = $1 and source_id = $2 order by at desc, id desc limit $3`,
    [db.tenantId, sourceId, limit],
  );
  return rows;
}

export interface SourceState {
  id: string;
  name: string;
  status: Source["status"];
  tokenHint: string | null;
  lastSeen: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export async function scopedSources(db: TenantDb, objectId: string): Promise<SourceState[]> {
  const { rows } = await db.query<{ id: string; name: string; status: Source["status"]; token_hint: string | null; last_seen: Date | null; last_error: string | null; created_at: Date }>(
    `select id, name, status, token_hint, last_seen, last_error, created_at from sources
     where tenant_id = $1 and connector = 'push' and config->'scope'->>'id' = $2 order by name`,
    [db.tenantId, objectId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, tokenHint: r.token_hint, lastSeen: r.last_seen, lastError: r.last_error, createdAt: r.created_at }));
}
