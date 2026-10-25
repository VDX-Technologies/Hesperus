// Plain Postgres access for the engine (no provider SDK): DATABASE_URL is any Postgres,
// on Supabase the transaction pooler (port 6543) for serverless, direct for jobs.
// The pool's own role bypasses RLS. It is only handed out two ways:
//   tenantDb(id)          every query runs as DATABASE_TENANT_ROLE (vdx_engine, no bypassrls) with
//                         app.tenant_id set, so RLS limits it to that tenant (migration engine_rls);
//                         the SQL guard (tenant_id = $1) stays as a linter on top
//   crossTenantDb(capability) the privileged pool, for a reviewed cross-tenant call site
// On a connection inside inTransaction/tx the role and tenant are set once per transaction (and
// again when the tenant changes); a plain Client outside them (scripts, tests) gets the guard only.
// Keep crossTenantAccess use audited and validate authorization first.
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = /^[a-z_][a-z0-9_]*$/;

/** Connections inside inTransaction/tx, with the tenant whose RLS context is set (null: none yet). */
const transactions = new WeakMap<object, string | null>();

const isPool = (db: Db): db is Db & Pick<Pool, "connect"> => "totalCount" in db;

/** The statements that put the current transaction under RLS for a tenant, or null when disabled. */
function rlsContext(tenantId: string): string | null {
  const role = process.env.DATABASE_TENANT_ROLE ?? "vdx_engine";
  if (role === "off") return null;
  if (!ROLE.test(role)) throw new TenantScopeError("invalid DATABASE_TENANT_ROLE");
  if (!UUID.test(tenantId)) throw new TenantScopeError("tenant id must be a uuid");
  return `set local role ${role}; set local app.tenant_id = '${tenantId}'`;
}

/** Runs one query on a pooled connection in its own transaction, under the tenant's RLS context. */
async function onPool(pool: Pick<Pool, "connect">, context: string, text: string, values?: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query(`begin; ${context}`);
    const result = await c.query(text, values);
    await c.query("commit");
    return result;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** A Db for one tenant: RLS on the database side, plus a guard refusing common unscoped queries. */
export function forTenant(db: Db, tenantId: string): TenantDb {
  if (!tenantId) throw new TenantScopeError("tenant id is required");
  const query = ((sql: unknown, params?: unknown[]) => {
    const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
    const values = params ?? (sql as { values?: unknown[] }).values;
    // rejected like a failed query, so callers see one error path
    if (!TENANT_COLUMN.test(text) || !scopedTenantStatement(text))
      return Promise.reject(new TenantScopeError(`query must bind tenant_id to $1: ${text.slice(0, 80)}`));
    if (values?.[0] !== tenantId) return Promise.reject(new TenantScopeError("$1 must be the bound tenant id"));
    const inTx = transactions.has(db);
    if (!inTx && !isPool(db)) return db.query(text, values);
    let context: string | null;
    try { context = rlsContext(tenantId); } catch (e) { return Promise.reject(e); }
    if (!context) return db.query(text, values);
    if (!inTx && isPool(db)) return onPool(db, context, text, values);
    if (transactions.get(db) === tenantId) return db.query(text, values);
    // both queued now, in order, so a concurrent query for another tenant cannot slip in between
    transactions.set(db, tenantId);
    return Promise.all([db.query(context), db.query(text, values)]).then(([, result]) => result);
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
    transactions.set(c, null);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    transactions.delete(c);
    c.release();
  }
}

/** Uses one connection for a batch; works with both the production Pool and an existing Client. */
export async function inTransaction<T>(db: Db, fn: (connection: Db) => Promise<T>): Promise<T> {
  // only a Pool hands out connections: a Client's connect() would try to open itself again
  const client = isPool(db) ? await db.connect() : null;
  const connection = (client ?? db) as Db;
  // inside an outer transaction on the same connection: a savepoint, so the outer one stays open
  // and keeps its own RLS bookkeeping
  const owner = !transactions.has(connection);
  try {
    await connection.query(owner ? "begin" : "savepoint nested");
    if (owner) transactions.set(connection, null);
    const result = await fn(connection);
    await connection.query(owner ? "commit" : "release savepoint nested");
    return result;
  } catch (e) {
    await connection.query(owner ? "rollback" : "rollback to savepoint nested").catch(() => undefined);
    throw e;
  } finally {
    if (owner) transactions.delete(connection);
    client?.release();
  }
}

/**
 * Takes a per-tenant advisory lock on key until the current transaction ends, so a
 * count-then-insert limit check cannot be passed by two concurrent requests.
 */
export async function lockTenant(connection: Db, tenantId: string, key: string) {
  if (!transactions.has(connection)) throw new Error("lockTenant needs a transaction");
  await connection.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenantId}:${key}`]);
}

/** Runs fn in a transaction holding lockTenant(key). */
export function withTenantLock<T>(db: TenantDb, key: string, fn: (txdb: TenantDb) => Promise<T>): Promise<T> {
  return inTransaction(db.shared, async (connection) => {
    await lockTenant(connection, db.tenantId, key);
    return fn(forTenant(connection, db.tenantId));
  });
}
