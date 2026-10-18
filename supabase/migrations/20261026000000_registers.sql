-- Generic registers: every event type with a schema gets a list, an entry form and exports.
--   event_types.subject      -> object type the events are about ('agronomy.crop', 'core.area'),
--                               the entry form offers only objects of that type
--   event_types.from_subject -> {"field": "property"}: fields filled from the chosen object
--   event_types.field_order  -> field keys in the order of the editor (jsonb keeps no order)
-- Types created by a tenant use module 'custom'. Adds three nullable/defaulted columns and two
-- settings; no existing row is changed.
alter table public.event_types
  add column subject text,
  add column from_subject jsonb not null default '{}',
  add column field_order text[];

insert into public.engine_settings (key, value, description) values
  ('registers.types_max', '50', 'Event types a tenant can create in the schema editor'),
  ('registers.export_chunk', '500', 'Rows read per query while exporting a register')
on conflict (key) do nothing;
