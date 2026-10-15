-- VDX Core: multi-tenant platform for the VDX ecosystem (Stoma, Tag, Kestrel, ...).
--
-- Tenancy: organization (customer) -> sites -> zones -> devices.
-- Modules (products) are enabled per organization in org_modules; the app only shows the
-- modules an organization has. Every row carries org_id and Row Level Security keeps each
-- customer inside its own data. VDX staff are platform_admins and can see everything.
-- Device data arrives through gateways (API key, verified server-side with the service role).

create extension if not exists pgcrypto;

create type public.member_role as enum ('owner', 'member', 'viewer');
create type public.alert_level as enum ('info', 'warn', 'alarm');

-- ---------------------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  locale text not null default 'en' check (locale in ('en', 'it')),
  created_at timestamptz not null default now()
);

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'viewer',
  primary key (org_id, user_id)
);

create table public.org_modules (
  org_id uuid not null references public.organizations (id) on delete cascade,
  module text not null,                       -- 'stoma', 'tag', 'kestrel', 'assistant', ...
  enabled boolean not null default true,
  config jsonb not null default '{}',          -- module settings for this customer (thresholds, ...)
  primary key (org_id, module)
);

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.zones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  zone_id uuid references public.zones (id) on delete set null,
  module text not null,
  serial text not null,                        -- id on the radio (e.g. Stoma NODE_ID)
  name text not null,
  config jsonb not null default '{}',          -- per-device overrides
  last_seen timestamptz,
  last_status text,                            -- 'ok' | 'warn' | 'alarm' | 'offline'
  last_values jsonb,
  created_at timestamptz not null default now(),
  unique (org_id, module, serial)
);

create table public.gateways (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  key_hash text not null unique,               -- sha256 of the API key; the key itself is shown once
  key_hint text not null,                      -- last 4 chars, to recognise it in the console
  last_seen timestamptz,
  created_at timestamptz not null default now()
);

create table public.readings (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  ts timestamptz not null default now(),
  values jsonb not null,                       -- module-defined metrics, e.g. {"temp_c": 21.4, ...}
  status text,
  meta jsonb not null default '{}'             -- radio info, flags (rssi, snr, irrigation, ...)
);
create index readings_device_ts on public.readings (device_id, ts desc);
create index readings_org_ts on public.readings (org_id, ts desc);

create table public.alerts (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  device_id uuid references public.devices (id) on delete cascade,
  ts timestamptz not null default now(),
  level public.alert_level not null,
  code text not null,                          -- module-defined, e.g. 'stoma.condensation'
  params jsonb not null default '{}',          -- values for the translated message
  resolved_at timestamptz
);
create index alerts_org_open on public.alerts (org_id, ts desc) where resolved_at is null;

create table public.dashboards (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  layout jsonb not null default '[]',          -- [{ "widget": "stoma.overview", "size": "l" }, ...]
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------
-- Helpers for RLS (security definer: they read memberships without recursive policies)
create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

create or replace function public.org_role(target uuid) returns public.member_role
language sql stable security definer set search_path = public as $$
  select role from public.memberships where org_id = target and user_id = auth.uid()
$$;

create or replace function public.can_read(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin() or public.org_role(target) is not null
$$;

create or replace function public.can_manage(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin() or public.org_role(target) = 'owner'
$$;

-- ---------------------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.platform_admins enable row level security;
alter table public.memberships enable row level security;
alter table public.org_modules enable row level security;
alter table public.sites enable row level security;
alter table public.zones enable row level security;
alter table public.devices enable row level security;
alter table public.gateways enable row level security;
alter table public.readings enable row level security;
alter table public.alerts enable row level security;
alter table public.dashboards enable row level security;

create policy "read own org" on public.organizations for select using (public.can_read(id));
create policy "admins manage orgs" on public.organizations for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

create policy "admins see admins" on public.platform_admins for select
  using (public.is_platform_admin() or user_id = auth.uid());

create policy "read memberships" on public.memberships for select
  using (user_id = auth.uid() or public.can_manage(org_id));
create policy "manage memberships" on public.memberships for all
  using (public.can_manage(org_id)) with check (public.can_manage(org_id));

-- Modules are sold by VDX: customers read them, only VDX changes them.
create policy "read modules" on public.org_modules for select using (public.can_read(org_id));
create policy "admins manage modules" on public.org_modules for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Structure and devices: owners may rename/organise their own things.
create policy "read sites" on public.sites for select using (public.can_read(org_id));
create policy "manage sites" on public.sites for all
  using (public.can_manage(org_id)) with check (public.can_manage(org_id));
create policy "read zones" on public.zones for select using (public.can_read(org_id));
create policy "manage zones" on public.zones for all
  using (public.can_manage(org_id)) with check (public.can_manage(org_id));
create policy "read devices" on public.devices for select using (public.can_read(org_id));
create policy "manage devices" on public.devices for all
  using (public.can_manage(org_id)) with check (public.can_manage(org_id));

create policy "admins see gateways" on public.gateways for select using (public.can_manage(org_id));
create policy "admins manage gateways" on public.gateways for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Readings are written only by the ingest API (service role, bypasses RLS).
create policy "read readings" on public.readings for select using (public.can_read(org_id));

create policy "read alerts" on public.alerts for select using (public.can_read(org_id));
create policy "resolve alerts" on public.alerts for update
  using ((public.can_read(org_id) and public.org_role(org_id) <> 'viewer') or public.is_platform_admin())
  with check (public.can_read(org_id));

create policy "read dashboard" on public.dashboards for select using (public.can_read(org_id));
create policy "manage dashboard" on public.dashboards for all
  using (public.can_manage(org_id)) with check (public.can_manage(org_id));

-- Live updates in the app
alter publication supabase_realtime add table public.devices, public.alerts;
