-- Drops the old sites and zones tables: 20261020010000_places_data moved them into place
-- objects with the same ids. Stops instead if a row was never moved, so nothing is lost.
do $$
declare missing int;
begin
  select count(*) into missing from (
    select id from public.sites union all select id from public.zones
  ) old where not exists (select 1 from public.objects o where o.id = old.id);
  if missing > 0 then
    raise exception 'sites/zones: % rows not moved to objects, run 20261020010000_places_data.sql first', missing;
  end if;
end $$;

drop table public.zones;
drop table public.sites;
