-- Official weather warnings are stored separately from sensor alerts. A warning is tied to
-- a geocoded site only after its official GeoJSON geometry contains that site's coordinates.

create table public.weather_locations (
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null,
  address text not null,
  normalized_address text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  geocode_source text not null default 'OpenStreetMap Nominatim',
  geocode_precision text not null check (geocode_precision in ('building', 'street', 'postcode', 'locality', 'region', 'manual')),
  geocoded_at timestamptz not null default now(),
  enabled boolean not null default true,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, site_id),
  foreign key (tenant_id, site_id) references public.objects (tenant_id, id) on delete cascade
);
create index weather_locations_country on public.weather_locations (country_code) where enabled;

create or replace function public.weather_location_validate_site() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from public.objects o join public.object_types t on t.id = o.type_id
    where o.tenant_id = new.tenant_id and o.id = new.site_id
      and t.module = 'core' and t.key = 'site'
  ) then
    raise exception 'weather locations can only be attached to core.site objects' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger weather_location_site before insert or update of tenant_id, site_id
  on public.weather_locations for each row execute function public.weather_location_validate_site();

create table public.weather_alerts (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null,
  source text not null check (source in ('meteogate_meteoalarm', 'vdx_rule')),
  external_id text not null,
  source_feature_id text,
  hazard text not null,
  severity text not null check (severity in ('yellow', 'orange', 'red')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  title text not null,
  description text,
  issued_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  acquired_at timestamptz not null default now(),
  source_url text not null,
  source_geometry jsonb,
  source_data jsonb not null default '{}',
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  last_seen_at timestamptz not null default now(),
  foreign key (tenant_id, site_id) references public.weather_locations (tenant_id, site_id) on delete cascade,
  unique (tenant_id, site_id, source, external_id)
);
create index weather_alerts_tenant_status on public.weather_alerts (tenant_id, status, severity, starts_at);
create index weather_alerts_site_history on public.weather_alerts (tenant_id, site_id, acquired_at desc);

create table public.weather_notification_subscriptions (
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index weather_notification_subscriptions_enabled
  on public.weather_notification_subscriptions (tenant_id) where enabled;

-- Durable and idempotent; a transient mail provider failure is retried by the scheduled worker.
create table public.weather_notification_outbox (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  alert_id bigint not null references public.weather_alerts (id) on delete cascade,
  recipient_user_id uuid not null references auth.users (id) on delete cascade,
  recipient_email text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  attempts integer not null default 0,
  claimed_until timestamptz,
  sent_at timestamptz,
  last_error text,
  unique (alert_id, recipient_user_id)
);
create index weather_outbox_pending on public.weather_notification_outbox (available_at, id) where sent_at is null;

alter table public.weather_locations enable row level security;
alter table public.weather_alerts enable row level security;
alter table public.weather_notification_subscriptions enable row level security;
alter table public.weather_notification_outbox enable row level security;

create policy weather_locations_read on public.weather_locations for select using (public.can_read(tenant_id));
create policy weather_locations_manage on public.weather_locations for all
  using (public.can_manage(tenant_id)) with check (public.can_manage(tenant_id));
create policy weather_alerts_read on public.weather_alerts for select using (public.can_read(tenant_id));
create policy weather_subscriptions_read on public.weather_notification_subscriptions for select
  using (user_id = auth.uid() and public.can_read(tenant_id));
create policy weather_outbox_read on public.weather_notification_outbox for select
  using (recipient_user_id = auth.uid() and public.can_read(tenant_id));

insert into public.engine_jobs (name) values ('weather') on conflict do nothing;

-- One official request per country is shared by tenant syncs and manual refreshes.
create table public.weather_source_cache (
  country_code text primary key check (country_code ~ '^[A-Z]{2}$'),
  fetched_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  payload jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
alter table public.weather_source_cache enable row level security;
create policy weather_source_cache_admin on public.weather_source_cache for select using (public.is_platform_admin());
