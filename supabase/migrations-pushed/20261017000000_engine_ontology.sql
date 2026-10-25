-- VDX Engine, phase 1: the ontology.
--
-- A sector-agnostic data model. Nothing here knows about any module: modules (Stoma, ...)
-- are configuration packages that register object types and metric keys as rows.
--
--   object_types  -> what kinds of things exist (typed property schema, owned by a module)
--   objects       -> the things (properties validated against their type, plus runtime state)
--   links         -> typed relations between objects
--   events        -> things that happened (severity, payload), tied to one or more objects
--   metrics       -> narrow time series (object, metric, ts, value), partitioned by day
--   metric_rollups-> 5 min / 1 h aggregates (min, max, avg, count)
--   documents     -> files on object storage, metadata and extracted text
--   sources       -> where data comes from (push / pull / upload connectors)
--   raw_inbox     -> buffer of raw messages, flushed hourly to object storage in batches
--   engine_settings -> every limit, window and frequency used by jobs and app
--
-- Every tenant table carries tenant_id and Row Level Security. Writes of data (metrics,
-- events, raw) go through the service role used by ingestion; users only read them.
-- Standard Postgres only. Existing tables are untouched.

-- ---------------------------------------------------------------------------------------
-- Dictionaries

create table public.metric_keys (
  id smallint generated always as identity primary key,
  module text not null,
  key text not null,
  unit text,
  label jsonb not null default '{}',           -- {"en": "...", "it": "..."}
  unique (module, key)
);

create table public.object_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.organizations (id) on delete cascade,  -- null = global
  module text not null,
  key text not null,
  name jsonb not null default '{}',
  properties jsonb not null default '{}',      -- {"prop": {"type": "number", "required": true, ...}}
  created_at timestamptz not null default now()
);
create unique index object_types_global_key on public.object_types (module, key) where tenant_id is null;
create unique index object_types_tenant_key on public.object_types (tenant_id, module, key) where tenant_id is not null;

-- ---------------------------------------------------------------------------------------
-- Property validation. Schema: {"name": {"type": t, "required": bool, "enum": [...],
-- "min": n, "max": n}} with t in string, number, integer, boolean, object, array, timestamp.
-- Unknown properties are rejected. Returns null when valid, else a readable error.

create or replace function public.validate_properties(schema jsonb, props jsonb) returns text
language plpgsql immutable as $$
declare
  k text;
  spec jsonb;
  v jsonb;
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
    if jsonb_typeof(v) = 'number' then
      if spec ? 'min' and (v #>> '{}')::numeric < (spec ->> 'min')::numeric then
        return format('property "%s" must be >= %s', k, spec ->> 'min');
      end if;
      if spec ? 'max' and (v #>> '{}')::numeric > (spec ->> 'max')::numeric then
        return format('property "%s" must be <= %s', k, spec ->> 'max');
      end if;
    end if;
  end loop;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Objects and links

create table public.objects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  type_id uuid not null references public.object_types (id),
  external_id text,                            -- id in the source system (serial, node id, ...)
  name text,
  properties jsonb not null default '{}',      -- validated against the type
  state jsonb not null default '{}',           -- runtime state (stateful derived metrics, ...)
  status text,
  last_seen timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, type_id, external_id)
);

create or replace function public.objects_validate() returns trigger
language plpgsql as $$
declare
  t public.object_types;
  err text;
begin
  select * into t from public.object_types where id = new.type_id;
  if t.tenant_id is not null and t.tenant_id <> new.tenant_id then
    raise exception 'object type belongs to another tenant' using errcode = '23514';
  end if;
  err := public.validate_properties(t.properties, new.properties);
  if err is not null then
    raise exception 'invalid properties for %.%: %', t.module, t.key, err using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger objects_validate before insert or update of type_id, properties, tenant_id
  on public.objects for each row execute function public.objects_validate();

create table public.links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  type text not null,                          -- 'located_in', 'connected_to', ...
  src_id uuid not null,
  dst_id uuid not null,
  properties jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (tenant_id, src_id) references public.objects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, dst_id) references public.objects (tenant_id, id) on delete cascade,
  unique (type, src_id, dst_id)
);
create index links_dst on public.links (dst_id);

-- ---------------------------------------------------------------------------------------
-- Sources (declared before events/raw that reference them)

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  connector text not null check (connector in ('push', 'pull', 'upload')),
  module text not null,
  config jsonb not null default '{}',
  token_hash text unique,                      -- sha256 of the push token
  token_hint text,
  status text not null default 'active' check (status in ('active', 'paused', 'error')),
  last_seen timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------
-- Events

create table public.events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  ts timestamptz not null default now(),
  type text not null,                          -- 'module.code'
  severity text not null check (severity in ('info', 'warn', 'alarm')),
  payload jsonb not null default '{}',
  source_id uuid references public.sources (id) on delete set null,
  unique (tenant_id, id)
);
create index events_tenant_ts on public.events (tenant_id, ts desc);

create table public.event_objects (
  tenant_id uuid not null,
  event_id bigint not null,
  object_id uuid not null,
  primary key (event_id, object_id),
  foreign key (tenant_id, event_id) references public.events (tenant_id, id) on delete cascade,
  foreign key (tenant_id, object_id) references public.objects (tenant_id, id) on delete cascade
);
create index event_objects_object on public.event_objects (object_id);

-- ---------------------------------------------------------------------------------------
-- Metrics: narrow, partitioned by day; retention drops whole partitions.

create table public.metrics (
  tenant_id uuid not null,
  object_id uuid not null,
  metric_id smallint not null references public.metric_keys (id),
  ts timestamptz not null,
  value double precision not null,
  primary key (object_id, metric_id, ts),
  foreign key (tenant_id, object_id) references public.objects (tenant_id, id) on delete cascade
) partition by range (ts);

create table public.metrics_default partition of public.metrics default;

create table public.metric_rollups (
  tenant_id uuid not null,
  object_id uuid not null,
  metric_id smallint not null references public.metric_keys (id),
  res integer not null check (res in (300, 3600)),   -- seconds
  bucket timestamptz not null,
  min double precision not null,
  max double precision not null,
  avg double precision not null,
  count integer not null,
  primary key (object_id, metric_id, res, bucket),
  foreign key (tenant_id, object_id) references public.objects (tenant_id, id) on delete cascade
);
create index metric_rollups_res_bucket on public.metric_rollups (res, bucket);

-- Creates daily partitions from today (UTC) to today + days_ahead. Days whose rows already
-- sit in the default partition are skipped (the attach would fail); they stay readable.
create or replace function public.ensure_metric_partitions(days_ahead integer default null)
returns integer language plpgsql as $$
declare
  ahead integer := coalesce(days_ahead, (public.engine_setting('metrics.partitions_ahead_days'))::integer, 3);
  d date;
  name text;
  created integer := 0;
begin
  for d in select generate_series((now() at time zone 'utc')::date,
                                  (now() at time zone 'utc')::date + ahead, '1 day')::date loop
    name := 'metrics_' || to_char(d, 'YYYYMMDD');
    continue when to_regclass('public.' || name) is not null;
    continue when exists (select 1 from public.metrics_default
                          where ts >= d::timestamp at time zone 'utc'
                            and ts < (d + 1)::timestamp at time zone 'utc');
    execute format(
      'create table public.%I partition of public.metrics for values from (%L) to (%L)',
      name, d::timestamp at time zone 'utc', (d + 1)::timestamp at time zone 'utc');
    created := created + 1;
  end loop;
  return created;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Documents (structure only for now)

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  storage_key text not null unique,            -- key on object storage
  filename text,
  content_type text,
  size bigint,
  sha256 text,
  metadata jsonb not null default '{}',
  text_content text,
  source_id uuid references public.sources (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.document_objects (
  tenant_id uuid not null,
  document_id uuid not null,
  object_id uuid not null,
  primary key (document_id, object_id),
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id) on delete cascade,
  foreign key (tenant_id, object_id) references public.objects (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------------------
-- Raw inbox: every accepted message lands here, then an hourly job writes one gzip batch
-- per source per hour to object storage and deletes the flushed rows.

create table public.raw_inbox (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  received_at timestamptz not null default now(),
  body jsonb not null
);
create index raw_inbox_source_received on public.raw_inbox (source_id, received_at);

-- ---------------------------------------------------------------------------------------
-- Settings: one place for every limit, window and frequency (jobs in SQL read it too).

create table public.engine_settings (
  key text primary key,
  value jsonb not null,
  description text
);

create or replace function public.engine_setting(k text) returns jsonb
language sql stable security definer set search_path = public as $$
  select value from public.engine_settings where key = k
$$;

insert into public.engine_settings (key, value, description) values
  ('retention.raw_days',            '14',    'Days of raw metrics kept in Postgres'),
  ('retention.rollup_5m_days',      '30',    'Days of 5 min rollups kept'),
  ('retention.rollup_1h_days',      'null',  'Days of hourly rollups kept (null = forever)'),
  ('rollup.interval_min',           '15',    'Rollup job frequency (minutes)'),
  ('rollup.lookback_min',           '60',    'Closed buckets recomputed each run for late data'),
  ('metrics.partitions_ahead_days', '3',     'Daily metric partitions created in advance'),
  ('query.raw_max_hours',           '24',    'Charts up to this span read raw metrics'),
  ('query.rollup_5m_max_days',      '7',     'Charts up to this span read 5 min rollups, longer read hourly'),
  ('raw.flush_interval_min',        '60',    'Raw inbox flush to object storage (minutes)'),
  ('raw.inbox_stale_min',           '120',   'Health check flags unflushed raw older than this'),
  ('quota.db_bytes',                '524288000',  'Database size limit (bytes)'),
  ('quota.r2_bytes',                '10737418240','Object storage size limit (bytes)'),
  ('quota.r2_writes_month',         '1000000',    'Object storage class A operations per month'),
  ('quota.r2_reads_month',          '10000000',   'Object storage class B operations per month'),
  ('quota.alert_ratio',             '0.8',   'Alert when a quota reaches this fraction'),
  ('health.source_silent_min',      '30',    'Alert when a source sends nothing for this long');

-- ---------------------------------------------------------------------------------------
-- Row Level Security

alter table public.metric_keys enable row level security;
alter table public.object_types enable row level security;
alter table public.objects enable row level security;
alter table public.links enable row level security;
alter table public.sources enable row level security;
alter table public.events enable row level security;
alter table public.event_objects enable row level security;
alter table public.metrics enable row level security;
alter table public.metric_rollups enable row level security;
alter table public.documents enable row level security;
alter table public.document_objects enable row level security;
alter table public.raw_inbox enable row level security;          -- service role only
alter table public.engine_settings enable row level security;

create policy "read metric keys" on public.metric_keys for select to authenticated using (true);
create policy "admins manage metric keys" on public.metric_keys for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

create policy "read types" on public.object_types for select
  using (tenant_id is null and auth.uid() is not null or public.can_read(tenant_id));
create policy "manage types" on public.object_types for all
  using (case when tenant_id is null then public.is_platform_admin() else public.can_manage(tenant_id) end)
  with check (case when tenant_id is null then public.is_platform_admin() else public.can_manage(tenant_id) end);

create policy "read objects" on public.objects for select using (public.can_read(tenant_id));
create policy "manage objects" on public.objects for all
  using (public.can_manage(tenant_id)) with check (public.can_manage(tenant_id));

create policy "read links" on public.links for select using (public.can_read(tenant_id));
create policy "manage links" on public.links for all
  using (public.can_manage(tenant_id)) with check (public.can_manage(tenant_id));

create policy "admins see sources" on public.sources for select using (public.can_manage(tenant_id));
create policy "admins manage sources" on public.sources for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

create policy "read events" on public.events for select using (public.can_read(tenant_id));
create policy "read event objects" on public.event_objects for select using (public.can_read(tenant_id));
create policy "read metrics" on public.metrics for select using (public.can_read(tenant_id));
create policy "read rollups" on public.metric_rollups for select using (public.can_read(tenant_id));
create policy "read documents" on public.documents for select using (public.can_read(tenant_id));
create policy "read document objects" on public.document_objects for select using (public.can_read(tenant_id));

create policy "admins read settings" on public.engine_settings for select using (public.is_platform_admin());
create policy "admins manage settings" on public.engine_settings for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

select public.ensure_metric_partitions();
