-- Push for the tenant's own types: limits on the files a source attaches to its objects.
insert into public.engine_settings (key, value, description) values
  ('push.document_max_bytes', '3145728', 'Largest file a push source can attach to an object, in bytes'),
  ('push.documents_per_day', '200', 'Files a push source can attach per day (the same file sent again is not counted)')
on conflict (key) do nothing;
