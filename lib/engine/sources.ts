// Sources and their push tokens. Only the sha256 of a token is stored; the token itself is
// shown once when the source is created.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db";
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
