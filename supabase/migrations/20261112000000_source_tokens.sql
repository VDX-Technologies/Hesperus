create table public.source_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  token_hash text not null unique,
  token_hint text not null,
  scopes text[] not null check (scopes <@ array['write', 'documents', 'read'] and cardinality(scopes) > 0),
  expires_at timestamptz,
  last_used_at timestamptz,
  last_used_ip inet,
  created_at timestamptz not null default now()
);
create index on public.source_tokens (source_id);

alter table public.sources add column last_used_ip inet;

alter table public.source_tokens enable row level security;
revoke all on public.source_tokens from anon, authenticated;
create policy engine_tenant on public.source_tokens for all to vdx_engine
  using (tenant_id = public.engine_tenant()) with check (tenant_id = public.engine_tenant());
