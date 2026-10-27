-- Typed events and data entered by people.
--   event_types     -> payload schema per event type ('module.key'), same format as
--                      object_types.properties plus the "quantity" type {value, unit}
--   events          -> who recorded it and when (recorded_at, author), and corrections:
--                      a correction is a new event that supersedes the previous version;
--                      the old one is kept, events_current shows only the latest
--   sources         -> new connector kind 'manual' (one per module per tenant)
-- Payloads of declared types are validated whatever the origin (push, upload, manual,
-- replay). Undeclared types (alert.*, records.entry, ...) stay free-form.
-- Existing rows: recorded_at is backfilled from ts, the other new columns stay null.

create table public.event_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.organizations (id) on delete cascade,  -- null = global
  module text not null,
  key text not null,
  name jsonb not null default '{}',
  fields jsonb not null default '{}',          -- {"field": {"type": ..., "required": ..., "units": [...]}}
  created_at timestamptz not null default now()
);
create unique index event_types_global_key on public.event_types (module, key) where tenant_id is null;
create unique index event_types_tenant_key on public.event_types (tenant_id, module, key) where tenant_id is not null;

alter table public.event_types enable row level security;
create policy "read event types" on public.event_types for select
  using (tenant_id is null and auth.uid() is not null or public.can_read(tenant_id));
create policy "manage event types" on public.event_types for all
  using (case when tenant_id is null then public.is_platform_admin() else public.can_manage(tenant_id) end)
  with check (case when tenant_id is null then public.is_platform_admin() else public.can_manage(tenant_id) end);

-- ---------------------------------------------------------------------------------------
-- validate_properties gains the "quantity" type: {"value": number, "unit": string}, with
-- "units" listing the allowed units and min/max applying to the value.

create or replace function public.validate_properties(schema jsonb, props jsonb) returns text
language plpgsql immutable as $$
declare
  k text;
  spec jsonb;
  v jsonb;
  n jsonb;
  t text;
begin
  if jsonb_typeof(props) is distinct from 'object' then
    return 'properties must be an object';
  end if;

  for k in select jsonb_object_keys(props) loop
    if not schema ? k then
      return format('unknown property "%s"', k);
    end if;
  end loop;

  for k, spec in select * from jsonb_each(schema) loop
    v := props -> k;
    if v is null or jsonb_typeof(v) = 'null' then
      if coalesce((spec ->> 'required')::boolean, false) then
        return format('property "%s" is required', k);
      end if;
      continue;
    end if;

    t := spec ->> 'type';
    n := v;
    if t = 'integer' then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then
        return format('property "%s" must be an integer', k);
      end if;
    elsif t = 'timestamp' then
      if jsonb_typeof(v) <> 'string' then
        return format('property "%s" must be a timestamp', k);
      end if;
      begin
        perform (v #>> '{}')::timestamptz;
      exception when others then
        return format('property "%s" must be a timestamp', k);
      end;
    elsif t = 'quantity' then
      if jsonb_typeof(v) <> 'object' or jsonb_typeof(v -> 'value') is distinct from 'number'
         or jsonb_typeof(v -> 'unit') is distinct from 'string'
         or exists (select 1 from jsonb_object_keys(v) x where x not in ('value', 'unit')) then
        return format('property "%s" must be a quantity {value, unit}', k);
      end if;
      if spec ? 'units' and not (spec -> 'units') @> jsonb_build_array(v -> 'unit') then
        return format('property "%s" unit must be one of %s', k, spec -> 'units');
      end if;
      n := v -> 'value';
    elsif t in ('string', 'number', 'boolean', 'object', 'array') then
      if jsonb_typeof(v) <> t then
        return format('property "%s" must be a %s', k, t);
      end if;
    else
      return format('property "%s" has unknown type "%s"', k, t);
    end if;

    if spec ? 'enum' and not (spec -> 'enum') @> jsonb_build_array(v) then
      return format('property "%s" must be one of %s', k, spec -> 'enum');
    end if;
    if jsonb_typeof(n) = 'number' then
      if spec ? 'min' and (n #>> '{}')::numeric < (spec ->> 'min')::numeric then
        return format('property "%s" must be >= %s', k, spec ->> 'min');
      end if;
      if spec ? 'max' and (n #>> '{}')::numeric > (spec ->> 'max')::numeric then
        return format('property "%s" must be <= %s', k, spec ->> 'max');
      end if;
    end if;
  end loop;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Events: author, recording time, versions.

alter table public.events
  add column recorded_at timestamptz,
  add column author uuid,                      -- auth user id; null for machine events
  add column author_label text,                -- email at the time, kept if the user goes
  add column supersedes bigint unique,         -- previous version (one correction per version)
  add column root_id bigint,                   -- first version of the chain
  add foreign key (tenant_id, supersedes) references public.events (tenant_id, id) on delete cascade;

update public.events set recorded_at = ts where recorded_at is null;
alter table public.events alter column recorded_at set default now(), alter column recorded_at set not null;

create index events_tenant_type_ts on public.events (tenant_id, type, ts desc);
create index events_author on public.events (tenant_id, author, type, recorded_at desc) where author is not null;
create index events_root on public.events (root_id) where root_id is not null;

create or replace function public.events_validate() returns trigger
language plpgsql as $$
declare
  et public.event_types;
  prev public.events;
  err text;
begin
  select * into et from public.event_types
   where module || '.' || key = new.type and (tenant_id is null or tenant_id = new.tenant_id)
   order by tenant_id nulls last limit 1;
  if found then
    err := public.validate_properties(et.fields, new.payload);
    if err is not null then
      raise exception 'invalid payload for %: %', new.type, err using errcode = '23514';
    end if;
  end if;

  if new.supersedes is not null then
    select * into prev from public.events where id = new.supersedes and tenant_id = new.tenant_id;
    if not found then
      raise exception 'event % not found', new.supersedes using errcode = '23503';
    end if;
    if prev.type <> new.type then
      raise exception 'a correction keeps the type (% <> %)', new.type, prev.type using errcode = '23514';
    end if;
    new.root_id := coalesce(prev.root_id, prev.id);
  end if;
  return new;
end;
$$;

create trigger events_validate before insert on public.events
  for each row execute function public.events_validate();

-- What people recorded is never changed or removed: corrections are new versions.
-- Deletes still pass inside a cascade (organization removed).
create or replace function public.events_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'recorded events cannot be changed; record a correction' using errcode = '42501';
end;
$$;

create trigger events_immutable before update or delete on public.events
  for each row when (old.author is not null) execute function public.events_immutable();

-- Latest version of every event (machine events are their own latest version). Read by the
-- engine only (the view would run with its owner's rights, so clients get no grant on it).
create view public.events_current as
  select e.* from public.events e
   where not exists (select 1 from public.events n where n.supersedes = e.id);
revoke all on public.events_current from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------

alter table public.sources drop constraint sources_connector_check;
alter table public.sources add constraint sources_connector_check
  check (connector in ('push', 'pull', 'upload', 'manual'));

insert into public.engine_settings (key, value, description) values
  ('manual.events_per_day', '500', 'Events a tenant can record by hand in 24 hours'),
  ('manual.max_objects', '20', 'Objects one manual event can be linked to')
on conflict (key) do nothing;
