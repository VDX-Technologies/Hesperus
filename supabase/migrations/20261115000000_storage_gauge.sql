-- Object storage size without listing the bucket every hour (a paginated LIST is a class A
-- operation per 1000 objects). Every store write adds its bytes here (recordUsage,
-- lib/engine/health.ts); the daily job lists the bucket once and sets the true value
-- (reconcileStorage), which also accounts for deletes. measured_at is that last listing.
create table public.engine_gauges (
  key text primary key,                        -- 'r2.bytes', 'r2.objects'
  n bigint not null default 0,
  measured_at timestamptz
);
alter table public.engine_gauges enable row level security;
revoke all on public.engine_gauges from anon, authenticated;
create policy engine_gauges_admin on public.engine_gauges for select using (public.is_platform_admin());
create policy engine_all on public.engine_gauges for all to vdx_engine using (true) with check (true);
