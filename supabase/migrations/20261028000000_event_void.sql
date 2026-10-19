-- Voiding a recorded event: a last version that keeps the payload and says why it no longer
-- counts. Nothing is removed; the voided chain drops out of the current events (lists,
-- dashboards, exports) and stays readable in the full history.
alter table public.events add column voided text check (voided is null or length(trim(voided)) > 0);

create or replace view public.events_current as
  select e.* from public.events e
   where not exists (select 1 from public.events n where n.supersedes = e.id)
     and e.voided is null;
revoke all on public.events_current from public, anon, authenticated;
