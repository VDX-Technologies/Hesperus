-- Places are objects: core.site (a place of its own) and core.area (part of a site or of
-- another area). Hierarchy and position are links:
--   part_of     area -> site | area   (one parent per area, no cycles)
--   located_in  object -> site | area (one place per object; places use part_of)
insert into public.object_types (module, key, name, properties) values
  ('core', 'site', '{"en": "Site", "it": "Sito"}', '{"notes": {"type": "string"}}'),
  ('core', 'area', '{"en": "Area", "it": "Area"}', '{"notes": {"type": "string"}}')
on conflict (module, key) where tenant_id is null do nothing;

create unique index links_one_place on public.links (src_id) where type = 'located_in';
create unique index links_one_parent on public.links (src_id) where type = 'part_of';

create or replace function public.place_kind(p_object uuid) returns text
language sql stable as $$
  select t.key from public.objects o join public.object_types t on t.id = o.type_id
  where o.id = p_object and t.module = 'core' and t.key in ('site', 'area')
$$;

create or replace function public.links_validate_places() returns trigger
language plpgsql as $$
declare
  src text := public.place_kind(new.src_id);
  dst text := public.place_kind(new.dst_id);
begin
  if new.type = 'part_of' then
    if src is distinct from 'area' or dst is null then
      raise exception 'part_of links an area to a site or an area' using errcode = '23514';
    end if;
    if exists (
      with recursive up(id) as (
        select new.dst_id
        union
        select l.dst_id from public.links l join up on l.src_id = up.id
        where l.type = 'part_of' and l.id is distinct from new.id
      ) select 1 from up where id = new.src_id
    ) then
      raise exception 'part_of would make a cycle' using errcode = '23514';
    end if;
  elsif new.type = 'located_in' then
    if src is not null or dst is null then
      raise exception 'located_in links an object to a site or an area' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger links_validate_places before insert or update on public.links
  for each row when (new.type in ('part_of', 'located_in'))
  execute function public.links_validate_places();
