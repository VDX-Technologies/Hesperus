-- Append-only audit log: who changed what, per tenant (tenant_id null = platform events).
-- object_id has no foreign key so the history of a deleted object stays readable.
-- Rows are written by the engine only; nothing may update or delete them except the
-- retention purge below (retention.audit_days, null = keep forever).
insert into public.engine_settings (key, value, description) values
  ('retention.audit_days', '365', 'Days of activity history kept (null = forever)')
on conflict (key) do nothing;

create table public.audit_log (
  id bigserial primary key,
  tenant_id uuid references public.organizations (id) on delete cascade,
  at timestamptz not null default now(),
  actor uuid,                 -- auth user, null for the system
  actor_label text,           -- e-mail at the time, kept if the user goes away
  action text not null,       -- dotted verb, e.g. place.create
  object_id uuid,
  subject text,               -- human label of the target at the time
  data jsonb not null default '{}'
);
create index audit_log_tenant_at on public.audit_log (tenant_id, at desc);
create index audit_log_object_at on public.audit_log (object_id, at desc) where object_id is not null;

alter table public.audit_log enable row level security;
create policy audit_log_read on public.audit_log for select
  using (case when tenant_id is null then public.is_platform_admin() else public.can_read(tenant_id) end);

-- Append-only: updates always fail, deletes only inside audit_purge (or an org cascade).
create or replace function public.audit_log_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and (current_setting('vdx.audit_purge', true) = 'on' or pg_trigger_depth() > 1) then
    return old;
  end if;
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;
create trigger audit_log_append_only before update or delete on public.audit_log
  for each row execute function public.audit_log_guard();

create or replace function public.audit_purge(p_now timestamptz default now())
returns integer language plpgsql as $$
declare
  days integer := (public.engine_setting('retention.audit_days') #>> '{}')::integer;
  n integer;
begin
  if days is null then return 0; end if;
  perform set_config('vdx.audit_purge', 'on', true);
  delete from public.audit_log where at < p_now - make_interval(days => days);
  get diagnostics n = row_count;
  perform set_config('vdx.audit_purge', 'off', true);
  return n;
end $$;
revoke all on function public.audit_purge(timestamptz) from public, anon, authenticated;

-- Same maintenance entry point, now also trimming the audit log.
create or replace function public.engine_maintenance(p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  started timestamptz := clock_timestamp();
  result jsonb;
begin
  insert into public.engine_jobs (name) values ('maintenance') on conflict do nothing;
  begin
    result := jsonb_build_object(
      'rollup', public.rollup_metrics(p_now),
      'retention', public.apply_retention(p_now),
      'audit_purged', public.audit_purge(p_now),
      'partitions_created', public.ensure_metric_partitions());
    update public.engine_jobs set last_run = started, last_ok = started, last_error = null,
      last_duration_ms = extract(epoch from clock_timestamp() - started) * 1000, last_result = result
    where name = 'maintenance';
  exception when others then
    update public.engine_jobs set last_run = started, last_error = sqlerrm,
      last_duration_ms = extract(epoch from clock_timestamp() - started) * 1000
    where name = 'maintenance';
    result := jsonb_build_object('error', sqlerrm);
  end;
  return result;
end;
$$;

-- Acknowledging an alert is recorded too (it runs as the user, so it writes its own row).
create or replace function public.ack_alert(alert_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare t uuid; obj uuid;
begin
  select tenant_id, object_id into t, obj from public.object_alerts where id = alert_id;
  if t is null or not public.can_read(t) then raise exception 'alert not found'; end if;
  update public.object_alerts set status = 'acknowledged', acked_at = now(), acked_by = auth.uid()
  where id = alert_id and status = 'open';
  if found then
    insert into public.audit_log (tenant_id, actor, actor_label, action, object_id, data)
    values (t, auth.uid(), (select email from auth.users where id = auth.uid()), 'alert.ack', obj,
            jsonb_build_object('alert_id', alert_id));
    return true;
  end if;
  return false;
end;
$$;
