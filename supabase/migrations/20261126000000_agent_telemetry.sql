-- Anonymous, opt-in telemetry from VDX Agent installs (open-source Mac app). Public ingest without
-- a token (POST /api/agent/telemetry), so it lives outside the tenant ontology: nothing here can
-- reach an organisation's data, and only platform admins read it (/admin/agent).
-- No IP, hostname, prompt or user content is stored; install_id is a random uuid made by the app.
create table public.agent_installs (
  id uuid primary key,
  app_version text not null default '',
  mac_model text not null default '',
  chip text not null default '',
  cpu_cores int not null default 0,
  ram_gb numeric not null default 0,
  macos text not null default '',
  python text not null default '',
  ollama text not null default '',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create table public.agent_turns (
  id bigint generated always as identity primary key,
  install_id uuid not null references public.agent_installs(id) on delete cascade,
  ts timestamptz not null,
  recorded_at timestamptz not null default now(),
  model text not null,
  family text not null default '',
  parameter_size text not null default '',
  quantization text not null default '',
  model_bytes bigint not null default 0,
  vram_bytes bigint not null default 0,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  duration_ms int not null default 0,
  load_ms int not null default 0,
  prompt_ms int not null default 0,
  gpu_ms int not null default 0,
  cpu_ms int not null default 0,
  tokens_per_s real not null default 0,
  tools int not null default 0,
  ok boolean not null default true,
  unique (install_id, ts)                      -- retried batches are idempotent
);
create index agent_turns_ts on public.agent_turns (ts desc);
create index agent_turns_install_recorded on public.agent_turns (install_id, recorded_at desc);

alter table public.agent_installs enable row level security;
alter table public.agent_turns enable row level security;
revoke all on public.agent_installs, public.agent_turns from anon, authenticated;
create policy agent_installs_admin on public.agent_installs for select using (public.is_platform_admin());
create policy agent_turns_admin on public.agent_turns for select using (public.is_platform_admin());
