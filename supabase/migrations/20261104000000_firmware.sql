create table public.firmware_releases (
  version text primary key check (version ~ '^\d+\.\d+\.\d+$'),
  md5 text not null check (md5 ~ '^[0-9a-f]{32}$'),
  size int not null check (size > 0),
  storage_key text not null,
  notes text,
  current boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index firmware_releases_one_current on public.firmware_releases (current) where current;

alter table public.firmware_releases enable row level security;
revoke all on public.firmware_releases from anon, authenticated;
