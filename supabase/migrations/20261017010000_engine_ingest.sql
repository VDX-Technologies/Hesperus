insert into public.engine_settings (key, value, description) values
  ('ingest.max_batch',     '500', 'Max messages accepted in one push request'),
  ('ingest.max_future_s',  '300', 'Reject measurements more than this many seconds in the future')
on conflict (key) do nothing;
