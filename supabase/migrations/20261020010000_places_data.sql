insert into public.objects (id, tenant_id, type_id, name, created_at)
select s.id, s.org_id, (select id from public.object_types where module = 'core' and key = 'site' and tenant_id is null),
       s.name, s.created_at
from public.sites s
on conflict (id) do nothing;

insert into public.objects (id, tenant_id, type_id, name, created_at)
select z.id, z.org_id, (select id from public.object_types where module = 'core' and key = 'area' and tenant_id is null),
       z.name, z.created_at
from public.zones z
on conflict (id) do nothing;

insert into public.links (tenant_id, type, src_id, dst_id)
select z.org_id, 'part_of', z.id, z.site_id from public.zones z
on conflict do nothing;

insert into public.links (tenant_id, type, src_id, dst_id)
select o.tenant_id, 'located_in', o.id, z.id
from public.objects o join public.zones z on z.org_id = o.tenant_id and z.id::text = o.properties->>'zone_id'
on conflict do nothing;

update public.objects set properties = properties - 'zone_id' where properties ? 'zone_id';
