create table public.engine_gauges (
  key text primary key,
  n bigint not null default 0,
  measured_at timestamptz
);
alter table public.engine_gauges enable row level security;
revoke all on public.engine_gauges from anon, authenticated;
create policy engine_gauges_admin on public.engine_gauges for select using (public.is_platform_admin());
create policy engine_all on public.engine_gauges for all to vdx_engine using (true) with check (true);
