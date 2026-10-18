// Health and quotas: measures the platform against the limits in engine_settings, keeps the
// open problems in engine_notices and mails the admins when one starts, repeats, or clears.
import type { Db } from "./db";
import type { Mailer } from "./mail";
import { getSettings, num, type Settings } from "./settings";
import type { ObjectStore, StoreOps } from "./store";

export interface Check {
  key: string; // stable: 'quota.db', 'source.<id>', ...
  ok: boolean;
  message: string;
  value?: number;
  limit?: number;
}

export interface Quota {
  key: string;
  used: number;
  limit: number;
}

export interface HealthReport {
  at: string;
  ok: boolean;
  quotas: Quota[];
  r2?: { objects: number; bytes: number };
  checks: Check[];
}

const month = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Adds the operations made through a metered store to this month's counters. */
export async function recordUsage(db: Db, ops: StoreOps, now = new Date()): Promise<void> {
  if (ops.writes) await db.query(`select engine_count('r2.writes', $1, $2)`, [ops.writes, now]);
  if (ops.reads) await db.query(`select engine_count('r2.reads', $1, $2)`, [ops.reads, now]);
}

export async function monthUsage(db: Db, now = new Date()): Promise<Record<string, number>> {
  const { rows } = await db.query<{ key: string; n: string }>(`select key, n from engine_usage where month = $1`, [month(now)]);
  return Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));
}

export async function dbBytes(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`select pg_database_size(current_database()) n`);
  return Number(rows[0].n);
}

const fmtBytes = (n: number) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};

function quotaCheck(q: Quota, ratio: number): Check {
  const pct = Math.round((100 * q.used) / q.limit);
  const bytes = q.key.endsWith("bytes");
  const show = bytes ? fmtBytes : (n: number) => n.toLocaleString("en");
  return {
    key: `quota.${q.key}`,
    ok: q.used < ratio * q.limit,
    message: `${q.key}: ${show(q.used)} of ${show(q.limit)} (${pct}%)`,
    value: q.used,
    limit: q.limit,
  };
}

/** Measures everything. store is optional: without it the object storage size is not checked. */
export async function collectHealth(db: Db, store?: ObjectStore, now = new Date()): Promise<HealthReport> {
  const s: Settings = await getSettings(db, true);
  const usage = await monthUsage(db, now);
  const r2 = store ? await store.usage("") : undefined;

  const quotas: Quota[] = [
    { key: "db_bytes", used: await dbBytes(db), limit: num(s, "quota.db_bytes", 524288000) },
    ...(r2 ? [{ key: "r2_bytes", used: r2.bytes, limit: num(s, "quota.r2_bytes", 10737418240) }] : []),
    { key: "r2_writes_month", used: usage["r2.writes"] ?? 0, limit: num(s, "quota.r2_writes_month", 1000000) },
    { key: "r2_reads_month", used: usage["r2.reads"] ?? 0, limit: num(s, "quota.r2_reads_month", 10000000) },
  ];
  const checks = quotas.map((q) => quotaCheck(q, num(s, "quota.alert_ratio", 0.8)));

  // Active sources that have pushed before and then went quiet.
  const silentMin = num(s, "health.source_silent_min", 30);
  const { rows: sources } = await db.query<{ id: string; name: string; org: string; last_seen: Date | null; silent: boolean }>(
    `select s.id, s.name, o.name org, s.last_seen,
            s.last_seen < $1::timestamptz - make_interval(mins => $2) silent
     from sources s join organizations o on o.id = s.tenant_id
     where s.status = 'active' and s.last_seen is not null`,
    [now, silentMin],
  );
  for (const r of sources) checks.push({
    key: `source.${r.id}`,
    ok: !r.silent,
    message: `source "${r.name}" (${r.org}) ${r.silent ? `silent since ${r.last_seen!.toISOString()}` : "is sending"}`,
  });

  // Sources hitting the push rate limit over and over this hour.
  const limitedMax = num(s, "health.rate_limited_per_h", 20);
  const { rows: limited } = await db.query<{ id: string; name: string; org: string; n: number }>(
    `select s.id, s.name, o.name org,
            case when r.limited_hour = date_trunc('hour', $1::timestamptz) then r.limited_count else 0 end n
     from source_rate r join sources s on s.id = r.source_id join organizations o on o.id = s.tenant_id
     where s.status = 'active'`,
    [now],
  );
  for (const r of limited) checks.push({
    key: `ratelimit.${r.id}`,
    ok: r.n <= limitedMax,
    message: `source "${r.name}" (${r.org}) ${r.n > limitedMax ? `rate limited ${r.n} times this hour` : "within its rate limit"}`,
    value: r.n,
    limit: limitedMax,
  });

  // Raw rows that should have been flushed to the archive long ago.
  const staleMin = num(s, "raw.inbox_stale_min", 120);
  const { rows: inbox } = await db.query<{ oldest: Date | null }>(`select min(received_at) oldest from raw_inbox`);
  const oldest = inbox[0].oldest;
  const stale = !!oldest && now.getTime() - oldest.getTime() > staleMin * 60000;
  checks.push({
    key: "raw.inbox",
    ok: !stale,
    message: stale ? `raw inbox not flushed since ${oldest!.toISOString()}` : "raw inbox is flushed",
  });

  const { rows: jobs } = await db.query<{ name: string; last_error: string | null }>(
    `select name, last_error from engine_jobs where name <> 'health' order by name`,
  );
  for (const j of jobs) checks.push({
    key: `job.${j.name}`,
    ok: !j.last_error,
    message: j.last_error ? `job ${j.name} failed: ${j.last_error}` : `job ${j.name} ok`,
  });

  return { at: now.toISOString(), ok: checks.every((c) => c.ok), quotas, r2, checks };
}

export interface NoticeChanges {
  opened: Check[];
  repeated: Check[];
  resolved: string[]; // messages of the problems that cleared
}

/**
 * Brings engine_notices in line with the checks and returns what should be mailed: new
 * problems, problems still open after alerts.repeat_h, and problems that cleared.
 */
export async function updateNotices(db: Db, checks: Check[], now = new Date()): Promise<NoticeChanges> {
  const s = await getSettings(db, true);
  const repeatMs = num(s, "alerts.repeat_h", 24) * 3600000;
  const { rows } = await db.query<{ key: string; message: string; last_sent: Date | null }>(
    `select key, message, last_sent from engine_notices where resolved_at is null`,
  );
  const open = new Map(rows.map((r) => [r.key, r]));
  const out: NoticeChanges = { opened: [], repeated: [], resolved: [] };

  for (const c of checks) {
    const n = open.get(c.key);
    open.delete(c.key);
    if (c.ok) {
      if (n) {
        await db.query(`update engine_notices set resolved_at = $2 where key = $1`, [c.key, now]);
        out.resolved.push(n.message);
      }
    } else if (!n) {
      await db.query(
        `insert into engine_notices (key, message, opened_at, last_sent) values ($1, $2, $3, $3)
         on conflict (key) do update set message = $2, opened_at = $3, last_sent = $3, resolved_at = null`,
        [c.key, c.message, now],
      );
      out.opened.push(c);
    } else {
      const due = !n.last_sent || now.getTime() - n.last_sent.getTime() >= repeatMs;
      await db.query(`update engine_notices set message = $2${due ? ", last_sent = $3" : ""} where key = $1`,
        due ? [c.key, c.message, now] : [c.key, c.message]);
      if (due) out.repeated.push(c);
    }
  }
  // Problems whose subject is gone (source deleted or paused, job removed) are cleared quietly.
  for (const key of open.keys()) await db.query(`update engine_notices set resolved_at = $2 where key = $1`, [key, now]);
  return out;
}

export function noticeMail(ch: NoticeChanges): { subject: string; text: string } | null {
  const problems = [...ch.opened, ...ch.repeated];
  if (!problems.length && !ch.resolved.length) return null;
  const lines: string[] = [];
  if (ch.opened.length) lines.push("New problems:", ...ch.opened.map((c) => `  - ${c.message}`), "");
  if (ch.repeated.length) lines.push("Still open:", ...ch.repeated.map((c) => `  - ${c.message}`), "");
  if (ch.resolved.length) lines.push("Resolved:", ...ch.resolved.map((m) => `  - ${m}`), "");
  const subject = problems.length
    ? `[VDX] ${problems.length} health problem${problems.length > 1 ? "s" : ""}: ${problems[0].message}`
    : `[VDX] ${ch.resolved.length} health problem${ch.resolved.length > 1 ? "s" : ""} resolved`;
  return { subject, text: lines.join("\n") };
}

/** alerts.email_to, or every platform admin when it is empty. */
export async function alertRecipients(db: Db): Promise<string[]> {
  const s = await getSettings(db, true);
  const to = s["alerts.email_to"];
  if (Array.isArray(to) && to.length) return to.filter((x): x is string => typeof x === "string");
  const { rows } = await db.query<{ email: string }>(
    `select u.email from platform_admins a join auth.users u on u.id = a.user_id where u.email is not null`,
  );
  return rows.map((r) => r.email);
}

/** The hourly job: measure, update notices, mail, and record the run in engine_jobs. */
export async function runHealth(db: Db, opts: { store?: ObjectStore; mailer?: Mailer | null; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const started = Date.now();
  await db.query(`insert into engine_jobs (name) values ('health') on conflict do nothing`);
  try {
    const report = await collectHealth(db, opts.store, now);
    const changes = await updateNotices(db, report.checks, now);
    const mail = noticeMail(changes);
    let mailed = 0;
    if (mail && opts.mailer) {
      const to = await alertRecipients(db);
      try {
        if (to.length) await opts.mailer.send({ to, ...mail, from: String((await getSettings(db, true))["alerts.email_from"]) });
      } catch (e) {
        // not delivered: the open problems are due again on the next run
        const keys = [...changes.opened, ...changes.repeated].map((c) => c.key);
        await db.query(`update engine_notices set last_sent = null where key = any($1)`, [keys]);
        throw e;
      }
      mailed = to.length;
    }
    await db.query(
      `update engine_jobs set last_run = $1, last_ok = $1, last_error = null, last_duration_ms = $2, last_result = $3
       where name = 'health'`,
      [now, Date.now() - started, { ...report, mailed }],
    );
    return { report, changes, mail, mailed };
  } catch (e) {
    await db.query(`update engine_jobs set last_run = $1, last_error = $2, last_duration_ms = $3 where name = 'health'`, [
      now, (e as Error).message, Date.now() - started,
    ]);
    throw e;
  }
}
