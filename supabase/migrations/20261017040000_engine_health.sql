insert into public.engine_settings (key, value, description) values
  ('alerts.email_to',   '[]',   'Health alert recipients (array of emails; empty = platform admins)'),
  ('alerts.email_from', '"VDX Core <alerts@vdxtechnologies.com>"', 'Sender of health alerts (a domain verified on the mail provider)'),
  ('alerts.repeat_h',   '24',   'Mail an open health problem again after this many hours')
on conflict (key) do nothing;

create table public.engine_usage (
  month date not null,
  key text not null,
  n bigint not null default 0,
  primary key (month, key)
);
alter table public.engine_usage enable row level security;
create policy engine_usage_admin on public.engine_usage for select using (public.is_platform_admin());

create table public.engine_notices (
  key text primary key,
  message text not null,
  opened_at timestamptz not null default now(),
  last_sent timestamptz,
  resolved_at timestamptz
);
alter table public.engine_notices enable row level security;
create policy engine_notices_admin on public.engine_notices for select using (public.is_platform_admin());

create or replace function public.engine_count(k text, n bigint, p_now timestamptz default now())
returns void language sql as $$
  insert into public.engine_usage (month, key, n)
  values (date_trunc('month', p_now, 'UTC')::date, k, n)
  on conflict (month, key) do update set n = engine_usage.n + excluded.n;
$$;
revoke execute on function public.engine_count(text, bigint, timestamptz) from public, anon, authenticated;
