-- Tenant isolation enforced by the database for the engine's direct pool. The pool connects as a
-- role that bypasses RLS; every tenantDb query now runs under `set local role vdx_engine` with
-- `app.tenant_id` set to the bound tenant (lib/engine/db.ts), so a query that forgets a tenant
-- filter, or joins a table it does not filter, only sees that tenant's rows.
-- crossTenantDb keeps the privileged role for reviewed cross-tenant call sites.
-- A new table with RLS enabled is invisible to vdx_engine until it gets a policy here (fail closed).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'vdx_engine') then
    create role vdx_engine nologin nobypassrls;
  end if;
end $$;
grant vdx_engine to current_user;
-- console policies are written for every role and call auth.uid(): inheriting authenticated gives
-- the engine the same schema access, and auth.uid() is null for it, so member policies never match
grant authenticated to vdx_engine;

grant usage on schema public to vdx_engine;
grant select, insert, update, delete on all tables in schema public to vdx_engine;
grant usage, select on all sequences in schema public to vdx_engine;
grant execute on function public.engine_setting(text), public.engine_count(text, bigint, timestamptz),
  public.ingest_take(uuid, timestamptz) to vdx_engine;
alter default privileges in schema public grant select, insert, update, delete on tables to vdx_engine;
alter default privileges in schema public grant usage, select on sequences to vdx_engine;

create function public.engine_tenant() returns uuid language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- tenant tables: the bound tenant only
do $$
declare t text;
begin
  foreach t in array array['document_objects', 'documents', 'event_objects', 'events', 'links',
    'metric_rollups', 'metrics', 'object_alerts', 'objects', 'push_subscriptions', 'raw_inbox',
    'rules', 'source_rate', 'sources']
  loop
    execute format('create policy engine_tenant on public.%I for all to vdx_engine
      using (tenant_id = public.engine_tenant()) with check (tenant_id = public.engine_tenant())', t);
  end loop;
end $$;

-- catalogs with shared rows (tenant_id null): package types are registered as shared rows from
-- inside a tenant's ingest, so shared rows stay readable and writable; other tenants' rows do not
do $$
declare t text;
begin
  foreach t in array array['event_types', 'object_types', 'audit_log'] loop
    execute format('create policy engine_tenant on public.%I for all to vdx_engine
      using (tenant_id is null or tenant_id = public.engine_tenant())
      with check (tenant_id is null or tenant_id = public.engine_tenant())', t);
  end loop;
end $$;

-- rule state follows its rule
create policy engine_tenant on public.rule_state for all to vdx_engine
  using (exists (select 1 from public.rules r where r.id = rule_id and r.tenant_id = public.engine_tenant()))
  with check (exists (select 1 from public.rules r where r.id = rule_id and r.tenant_id = public.engine_tenant()));

-- tables without a tenant (settings, catalogs, memberships, jobs): unchanged for the engine
do $$
declare t text;
begin
  foreach t in array array['dashboards', 'engine_jobs', 'engine_notices', 'engine_settings', 'engine_usage',
    'firmware_releases', 'memberships', 'metric_keys', 'org_modules', 'organizations', 'platform_admins',
    'research_consents']
  loop
    execute format('create policy engine_all on public.%I for all to vdx_engine using (true) with check (true)', t);
  end loop;
end $$;
