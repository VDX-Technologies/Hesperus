create index if not exists document_objects_object on public.document_objects (tenant_id, object_id);

insert into public.engine_settings (key, value, description) values
  ('objects.page_size', '100', 'Objects shown per page in a filtered list of a custom type')
on conflict (key) do nothing;
