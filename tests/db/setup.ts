// Shared DB harness: a throwaway database built from supabase/migrations.
// TEST_DATABASE_URL points at a server we may create databases on
// (default: local Supabase). Each test file gets its own fresh database.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const ROOT = join(__dirname, "..", "..");

export async function freshDb(): Promise<{ db: Client; url: string; drop: () => Promise<void> }> {
  const name = `vdx_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Client({ connectionString: BASE });
  await admin.connect().catch((e) => {
    throw new Error(`No test database at ${BASE} (${e.message}). Start Supabase (npx supabase start) or set TEST_DATABASE_URL.`);
  });
  await admin.query(`create database ${name}`);

  const url = new URL(BASE);
  url.pathname = `/${name}`;
  const db = new Client({ connectionString: url.toString() });
  await db.connect();

  const { rows } = await db.query("select to_regnamespace('auth') is not null as has_auth");
  if (!rows[0].has_auth) await db.query(readFileSync(join(ROOT, "tests/db/supabase-stub.sql"), "utf8"));
  const dir = join(ROOT, "supabase/migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.query(readFileSync(join(dir, f), "utf8"));
  }

  return {
    db,
    url: url.toString(),
    drop: async () => {
      await db.end();
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

// Runs fn as an authenticated user under RLS, inside a rolled-back transaction.
export async function asUser<T>(db: Client, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return await fn();
  } finally {
    await db.query("rollback");
  }
}
