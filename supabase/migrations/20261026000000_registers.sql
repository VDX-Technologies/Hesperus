alter table public.event_types
  add column subject text,
  add column from_subject jsonb not null default '{}',
  add column field_order text[];

insert into public.engine_settings (key, value, description) values
  ('registers.types_max', '50', 'Event types a tenant can create in the schema editor'),
  ('registers.export_chunk', '500', 'Rows read per query while exporting a register')
on conflict (key) do nothing;
