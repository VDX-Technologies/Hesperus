insert into public.engine_settings (key, value, description) values
  ('manual.objects_max', '500', 'Objects a tenant can create by hand in the console')
on conflict (key) do nothing;
