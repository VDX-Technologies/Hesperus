-- Health and quotas. The hourly health job (GitHub Actions, scripts/health.ts) measures the
-- database and the object storage against the quota.* settings, looks for silent sources,
-- a stuck raw inbox and failing jobs, stores the outcome in engine_jobs ('health') and mails
-- the platform admins. engine_notices remembers what was mailed, so a problem is mailed when
-- it starts, again every alerts.repeat_h while it lasts, and once when it clears.
-- Object storage operations are not visible from here: the jobs that touch R2 count them
-- into engine_usage, per month.

insert into public.engine_settings (key, value, description) values
  ('alerts.email_to',   '[]',   'Health alert recipients (array of emails; empty = platform admins)'),
  ('alerts.email_from', '"VDX Core <alerts@vdxtechnologies.com>"', 'Sender of health alerts (a domain verified on the mail provider)'),
  ('alerts.repeat_h',   '24',   'Mail an open health problem again after this many hours')
on conflict (key) do nothing;

create table public.engine_usage (
  month date not null,                         -- first day of the month (UTC)
  key text not null,                           -- 'r2.writes', 'r2.reads'
  n bigint not null default 0,
  primary key (month, key)
);
alter table public.engine_usage enable row level security;
create policy engine_usage_admin on public.engine_usage for select using (public.is_platform_admin());

create table public.engine_notices (
  key text primary key,                        -- check key, e.g. 'quota.db', 'source.<id>'
  message text not null,
  opened_at timestamptz not null default now(),
  last_sent timestamptz,
  resolved_at timestamptz
);
alter table public.engine_notices enable row level security;
create policy engine_notices_admin on public.engine_notices for select using (public.is_platform_admin());

-- Adds n to this month's counter.
create or replace function public.engine_count(k text, n bigint, p_now timestamptz default now())
returns void language sql as $$
  insert into public.engine_usage (month, key, n)
  values (date_trunc('month', p_now, 'UTC')::date, k, n)
  on conflict (month, key) do update set n = engine_usage.n + excluded.n;
$$;
revoke execute on function public.engine_count(text, bigint, timestamptz) from public, anon, authenticated;
