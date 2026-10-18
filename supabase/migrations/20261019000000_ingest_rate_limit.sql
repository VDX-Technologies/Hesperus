-- Per-source rate limit on push: a token bucket per source, refilled at ingest.rate_per_min
-- requests per minute up to ingest.burst. One atomic statement per request, no external service.
insert into public.engine_settings (key, value, description) values
  ('ingest.rate_per_min',     '120', 'Push requests per minute allowed per source (sustained)'),
  ('ingest.burst',            '60',  'Push requests a source may send at once before being limited'),
  ('health.rate_limited_per_h', '20', 'Flag a source limited more than this many times in an hour')
on conflict (key) do nothing;

create table public.source_rate (
  source_id uuid primary key references public.sources (id) on delete cascade,
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  tokens double precision not null,
  updated_at timestamptz not null default now(),
  limited_hour timestamptz,          -- start of the hour limited_count refers to
  limited_count integer not null default 0
);
alter table public.source_rate enable row level security;   -- engine only

-- Takes one token. Returns 0 when the request may go on, else the seconds until one is free.
-- The row lock serialises concurrent pushes of the same source.
create or replace function public.ingest_take(p_source uuid, p_now timestamptz default now())
returns double precision language plpgsql as $$
declare
  rate double precision := greatest(coalesce((select (value #>> '{}')::float8 from public.engine_settings where key = 'ingest.rate_per_min'), 120), 0.001) / 60;
  burst double precision := greatest(coalesce((select (value #>> '{}')::float8 from public.engine_settings where key = 'ingest.burst'), 60), 1);
  r public.source_rate;
  avail double precision;
begin
  insert into public.source_rate (source_id, tenant_id, tokens, updated_at)
  select s.id, s.tenant_id, burst, p_now from public.sources s where s.id = p_source
  on conflict (source_id) do nothing;
  select * into r from public.source_rate where source_id = p_source for update;
  if not found then return 0; end if;

  avail := least(burst, r.tokens + greatest(extract(epoch from p_now - r.updated_at), 0) * rate);
  if avail >= 1 then
    update public.source_rate set tokens = avail - 1, updated_at = p_now where source_id = p_source;
    return 0;
  end if;

  -- denied: count it per hour and tell the source why
  update public.source_rate set
    tokens = avail, updated_at = p_now,
    limited_count = case when limited_hour = date_trunc('hour', p_now) then limited_count + 1 else 1 end,
    limited_hour = date_trunc('hour', p_now)
  where source_id = p_source;
  update public.sources set last_error = 'rate limited' where id = p_source;
  return (1 - avail) / rate;
end $$;
revoke all on function public.ingest_take(uuid, timestamptz) from public, anon, authenticated;
