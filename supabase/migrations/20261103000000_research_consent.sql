-- Consent to use collected data for scientific research and laboratory work. One row per user
-- (not per organization): created when the user signs the document on first access, after which
-- the document is never shown again. Only the settings page changes "granted" afterwards; the
-- signature (name, version, time) stays as evidence of the original acceptance.
create table public.research_consents (
  user_id uuid primary key references auth.users (id) on delete cascade,
  version text not null,                       -- version of the document that was signed
  signed_name text not null check (length(trim(signed_name)) between 2 and 200),
  signed_at timestamptz not null default now(),
  user_agent text,
  granted boolean not null default true,       -- false = withdrawn from the settings page
  changed_at timestamptz not null default now()
);

alter table public.research_consents enable row level security;
create policy research_consents_read on public.research_consents for select using (user_id = auth.uid());
create policy research_consents_sign on public.research_consents for insert with check (user_id = auth.uid() and granted);
create policy research_consents_change on public.research_consents for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The signature is written once; later only the decision and its time can change.
revoke insert, update, delete on public.research_consents from anon, authenticated;
grant insert (user_id, version, signed_name, user_agent) on public.research_consents to authenticated;
grant update (granted, changed_at) on public.research_consents to authenticated;
