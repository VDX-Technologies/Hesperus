create table public.source_errors (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  at timestamptz not null default now(),
  error text not null
);
create index on public.source_errors (source_id, at desc);

alter table public.source_errors enable row level security;
revoke all on public.source_errors from anon, authenticated;
create policy engine_tenant on public.source_errors for all to vdx_engine
  using (tenant_id = public.engine_tenant()) with check (tenant_id = public.engine_tenant());
