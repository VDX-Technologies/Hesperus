-- Object types made by the tenant in the schema editor (module "custom"), like event types.
-- Rows already fit object_types: tenant_id set, read and manage policies are tenant-aware.
-- What this adds, all generic:
--   links         declared links of the type: {"project": {"type": "custom.project", "required": true}}
--                 (the key is the link type in public.links; part_of and located_in stay with places)
--   field_order   the editor's order of the properties
--   format        a property {"type": "object", "format": "schema"} holds a field schema itself
--   schemaFrom    a property {"type": "object", "schemaFrom": "project.result_schema"} is validated
--                 against the schema held by the object it is linked to through "project"
--   also          event_types: other object types an event may be linked to besides its subject
-- A parent's schema can change later: objects already saved are not checked again until they are
-- written, the same rule as a type whose schema changes.

alter table public.object_types
  add column links jsonb not null default '{}',
  add column field_order text[];

alter table public.event_types add column also text[] not null default '{}';

insert into public.engine_settings (key, value, description) values
  ('registers.object_types_max', '30', 'Object types a tenant can create in the schema editor'),
  ('custom.objects_max', '5000', 'Objects of custom types a tenant can hold')
on conflict (key) do nothing;

-- Problems of a field schema held as a value (format "schema"); null when fine. The editor checks
-- the same rules first with readable messages (checkFields).
create or replace function public.check_field_schema(s jsonb) returns text
language plpgsql immutable as $$
declare
  k text;
  spec jsonb;
begin
  if s is null or jsonb_typeof(s) <> 'object' then return 'schema must be an object'; end if;
  if (select count(*) from jsonb_object_keys(s)) > 40 then return 'too many fields'; end if;
  for k, spec in select * from jsonb_each(s) loop
    if k !~ '^[a-z][a-z0-9_]{0,39}$' then return format('invalid field key "%s"', k); end if;
    if jsonb_typeof(spec) <> 'object'
       or coalesce(spec->>'type', '') not in ('string', 'number', 'integer', 'boolean', 'timestamp', 'quantity', 'object') then
      return format('invalid type for "%s"', k);
    end if;
    if spec ? 'enum' and jsonb_typeof(spec->'enum') <> 'array' then return format('invalid options for "%s"', k); end if;
  end loop;
  return null;
end;
$$;

-- Checks the schemaFrom properties of an object against its parents' schemas. The parent through
-- link `via` can be given (a link being inserted), else it is read from public.links; a property
-- whose parent is not linked yet is checked when the link is made.
create or replace function public.check_delegated(
  tenant uuid, obj uuid, schema jsonb, props jsonb, via text default null, via_dst uuid default null
) returns text
language plpgsql stable as $$
declare
  k text;
  spec jsonb;
  link text;
  parent uuid;
  delegated jsonb;
  err text;
begin
  for k, spec in select * from jsonb_each(schema) where value ? 'schemaFrom' loop
    continue when props->k is null or props->k = 'null'::jsonb;
    link := split_part(spec->>'schemaFrom', '.', 1);
    parent := case when link = via then via_dst
                   else (select dst_id from public.links l where l.tenant_id = tenant and l.src_id = obj and l.type = link limit 1) end;
    continue when parent is null;
    select o.properties->split_part(spec->>'schemaFrom', '.', 2) into delegated
      from public.objects o where o.tenant_id = tenant and o.id = parent;
    err := public.validate_properties(coalesce(delegated, '{}'), props->k);
    if err is not null then return format('%s: %s', k, err); end if;
  end loop;
  return null;
end;
$$;

create or replace function public.objects_validate_schemas() returns trigger
language plpgsql as $$
declare
  t public.object_types;
  k text;
  err text;
begin
  select * into t from public.object_types where id = new.type_id;
  for k in select key from jsonb_each(t.properties) where value->>'format' = 'schema' loop
    if new.properties ? k and new.properties->k <> 'null'::jsonb then
      err := public.check_field_schema(new.properties->k);
      if err is not null then
        raise exception 'invalid properties for %.%: %: %', t.module, t.key, k, err using errcode = '23514';
      end if;
    end if;
  end loop;
  err := public.check_delegated(new.tenant_id, new.id, t.properties, new.properties);
  if err is not null then
    raise exception 'invalid properties for %.%: %', t.module, t.key, err using errcode = '23514';
  end if;
  return new;
end;
$$;

-- runs after objects_validate (triggers fire in name order)
create trigger objects_validate_schemas before insert or update of type_id, properties, tenant_id
  on public.objects for each row execute function public.objects_validate_schemas();

-- A link from an object whose type declares links must be one of them, to an object of the
-- declared type, one per key; types without declared links (packages) keep any link.
create or replace function public.links_validate_declared() returns trigger
language plpgsql as $$
declare
  t public.object_types;
  tid uuid;
  props jsonb;
  dst_type text;
  err text;
begin
  select o.type_id, o.properties into tid, props from public.objects o where o.tenant_id = new.tenant_id and o.id = new.src_id;
  select * into t from public.object_types where id = tid;
  if t.links is null or t.links = '{}'::jsonb then return new; end if;
  if not t.links ? new.type then
    raise exception 'link "%" is not declared by %.%', new.type, t.module, t.key using errcode = '23514';
  end if;
  select ot.module || '.' || ot.key into dst_type
    from public.objects o join public.object_types ot on ot.id = o.type_id
   where o.tenant_id = new.tenant_id and o.id = new.dst_id;
  if dst_type is distinct from t.links->new.type->>'type' then
    raise exception 'link "%" must point to %', new.type, t.links->new.type->>'type' using errcode = '23514';
  end if;
  if exists (select 1 from public.links l where l.tenant_id = new.tenant_id and l.src_id = new.src_id
               and l.type = new.type and l.id <> new.id) then
    raise exception 'link "%" is already set', new.type using errcode = '23514';
  end if;
  err := public.check_delegated(new.tenant_id, new.src_id, t.properties, props, new.type, new.dst_id);
  if err is not null then
    raise exception 'invalid properties for %.%: %', t.module, t.key, err using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger links_validate_declared before insert or update on public.links
  for each row when (new.type not in ('part_of', 'located_in')) execute function public.links_validate_declared();
