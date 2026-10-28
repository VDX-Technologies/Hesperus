do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'vdx_engine') then
    create role vdx_engine nologin nobypassrls;
  end if;
end $$;
grant vdx_engine to current_user;
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

do $$
declare t text;
begin
  foreach t in array array['event_types', 'object_types', 'audit_log'] loop
    execute format('create policy engine_tenant on public.%I for all to vdx_engine
      using (tenant_id is null or tenant_id = public.engine_tenant())
      with check (tenant_id is null or tenant_id = public.engine_tenant())', t);
  end loop;
end $$;

create policy engine_tenant on public.rule_state for all to vdx_engine
  using (exists (select 1 from public.rules r where r.id = rule_id and r.tenant_id = public.engine_tenant()))
  with check (exists (select 1 from public.rules r where r.id = rule_id and r.tenant_id = public.engine_tenant()));

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
