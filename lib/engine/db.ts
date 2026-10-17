// Plain Postgres access for the engine (no provider SDK): DATABASE_URL is any Postgres,
// on Supabase the transaction pooler (port 6543) for serverless, direct for jobs.
import { Pool, type PoolClient } from "pg";

export type Db = { query: Pool["query"] };

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 3) });
  }
  return pool;
}

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
