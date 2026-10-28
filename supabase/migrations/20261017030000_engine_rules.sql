create table public.rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  key text not null,
  name text,
  module text not null,
  metric text not null,
  object_type text,
  object_id uuid,
  op text not null check (op in ('>', '>=', '<', '<=')),
  threshold double precision not null,
  hysteresis double precision not null default 0 check (hysteresis >= 0),
  for_s integer not null default 0 check (for_s >= 0),
  severity text not null check (severity in ('info', 'warn', 'alarm')),
  push_to_device boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, object_id) references public.objects (tenant_id, id) on delete cascade
);
create unique index rules_family_scope on public.rules
  (tenant_id, key, coalesce(object_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index rules_lookup on public.rules (tenant_id, module, metric) where enabled;

create table public.rule_state (
  rule_id uuid not null references public.rules (id) on delete cascade,
  object_id uuid not null references public.objects (id) on delete cascade,
  breach_since timestamptz,
  last_ts timestamptz not null,
  last_value double precision,
  primary key (rule_id, object_id)
);

create table public.object_alerts (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  rule_id uuid references public.rules (id) on delete set null,
  object_id uuid not null,
  severity text not null check (severity in ('info', 'warn', 'alarm')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  title text,
  opened_at timestamptz not null,
  value double precision,
  peak double precision,
  acked_at timestamptz,
  acked_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  ai jsonb,
  foreign key (tenant_id, object_id) references public.objects (tenant_id, id) on delete cascade
);
create unique index object_alerts_one_active on public.object_alerts (rule_id, object_id) where status <> 'resolved';
create index object_alerts_tenant_status on public.object_alerts (tenant_id, status, opened_at desc);

alter table public.rules enable row level security;
alter table public.rule_state enable row level security;
alter table public.object_alerts enable row level security;
create policy rules_read on public.rules for select using (public.can_read(tenant_id));
create policy rules_write on public.rules for all
  using (public.can_manage(tenant_id)) with check (public.can_manage(tenant_id));
create policy object_alerts_read on public.object_alerts for select using (public.can_read(tenant_id));

create or replace function public.ack_alert(alert_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  select tenant_id into t from public.object_alerts where id = alert_id;
  if t is null or not public.can_read(t) then raise exception 'alert not found'; end if;
  update public.object_alerts set status = 'acknowledged', acked_at = now(), acked_by = auth.uid()
  where id = alert_id and status = 'open';
  return found;
end;
$$;
revoke execute on function public.ack_alert(bigint) from public, anon;
grant execute on function public.ack_alert(bigint) to authenticated;
