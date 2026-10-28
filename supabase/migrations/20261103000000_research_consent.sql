create table public.research_consents (
  user_id uuid primary key references auth.users (id) on delete cascade,
  version text not null,
  signed_name text not null check (length(trim(signed_name)) between 2 and 200),
  signed_at timestamptz not null default now(),
  user_agent text,
  granted boolean not null default true,
  changed_at timestamptz not null default now()
);

alter table public.research_consents enable row level security;
create policy research_consents_read on public.research_consents for select using (user_id = auth.uid());
create policy research_consents_sign on public.research_consents for insert with check (user_id = auth.uid() and granted);
create policy research_consents_change on public.research_consents for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke insert, update, delete on public.research_consents from anon, authenticated;
grant insert (user_id, version, signed_name, user_agent) on public.research_consents to authenticated;
grant update (granted, changed_at) on public.research_consents to authenticated;
