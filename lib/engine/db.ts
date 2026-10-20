// Plain Postgres access for the engine (no provider SDK): DATABASE_URL is any Postgres,
// on Supabase the transaction pooler (port 6543) for serverless, direct for jobs.
// The pool bypasses RLS, so application scoping is defense in depth, not a database boundary.
// It is only handed out two ways:
//   tenantDb(id)          every query must name tenant_id and bind that tenant as $1
//   crossTenantDb(capability) an explicit capability for a reviewed cross-tenant call site
// The tenant SQL guard is a heuristic; this privileged pool bypasses RLS and neither helper is
// a database security boundary. Keep crossTenantAccess use audited and validate authorization first.
import { Pool, type PoolClient } from "pg";

export type Db = { query: Pool["query"] };

/** A Db bound to one tenant. `shared` reads tenant-less tables (settings, type catalog) only. */
export interface TenantDb extends Db {
  readonly tenantId: string;
  readonly shared: Db;
}

export class TenantScopeError extends Error {}

const TENANT_COLUMN = /\btenant_id\b/;

function scopedTenantStatement(sql: string) {
  // Ignore comments and quoted values so a tenant predicate mentioned in documentation or text
  // cannot satisfy this check. TenantDb calls must bind their organization as $1.
  const code = sql.replace(/'(?:''|[^'])*'/g, "''").replace(/--[^\r\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const predicate = /\b(?:[a-z_][\w$]*\s*\.\s*)?tenant_id\s*=\s*\$1\b/i.test(code);
  const insert = [...code.matchAll(/\binsert\s+into\s+[^;(]+\(([^)]*)\)\s*(?:values\s*\(\s*\$1\b|select\s+\$1\b)/gi)]
    .some(([, columns]) => columns.split(",").some((column) => column.trim().replaceAll('"', "").toLowerCase() === "tenant_id"));
  return predicate || insert;
}

/** Refuses common accidentally unscoped queries; this heuristic does not replace database RLS. */
export function forTenant(db: Db, tenantId: string): TenantDb {
  if (!tenantId) throw new TenantScopeError("tenant id is required");
  const query = ((sql: unknown, params?: unknown[]) => {
    const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
    const values = params ?? (sql as { values?: unknown[] }).values;
    // rejected like a failed query, so callers see one error path
    if (!TENANT_COLUMN.test(text) || !scopedTenantStatement(text))
      return Promise.reject(new TenantScopeError(`query must bind tenant_id to $1: ${text.slice(0, 80)}`));
    if (values?.[0] !== tenantId) return Promise.reject(new TenantScopeError("$1 must be the bound tenant id"));
    return db.query(text, values);
  }) as Db["query"];
  return { tenantId, query, shared: db };
}

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 3) });
  }
  return pool;
}

export const tenantDb = (tenantId: string): TenantDb => forTenant(getPool(), tenantId);

/** Explicit capabilities for the small set of reviewed cross-tenant call sites. */
const adminCapability = Symbol("cross-tenant:admin");
const ingestCapability = Symbol("cross-tenant:ingest");
const maintenanceCapability = Symbol("cross-tenant:maintenance");
const settingsCapability = Symbol("cross-tenant:settings");

export const crossTenantAccess = Object.freeze({
  admin: adminCapability,
  ingest: ingestCapability,
  maintenance: maintenanceCapability,
  settings: settingsCapability,
});

type CrossTenantCapability =
  | typeof adminCapability
  | typeof ingestCapability
  | typeof maintenanceCapability
  | typeof settingsCapability;

const crossTenantReasons = new Map<CrossTenantCapability, string>([
  [adminCapability, "admin"],
  [ingestCapability, "ingest"],
  [maintenanceCapability, "maintenance"],
  [settingsCapability, "settings"],
]);

export const crossTenantDb = (capability: CrossTenantCapability): Pool => {
  if (!crossTenantReasons.has(capability)) throw new Error("invalid cross-tenant database capability");
  return getPool();
};

/** Runs fn in a transaction on one connection. */
export async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** Uses one connection for a batch; works with both the production Pool and an existing Client. */
export async function inTransaction<T>(db: Db, fn: (connection: Db) => Promise<T>): Promise<T> {
  const connect = (db as Db & { connect?: () => Promise<PoolClient> }).connect;
  const client = connect ? await connect.call(db) : null;
  const connection = (client ?? db) as Db;
  try {
    await connection.query("begin");
    const result = await fn(connection);
    await connection.query("commit");
    return result;
  } catch (e) {
    await connection.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client?.release();
  }
}
