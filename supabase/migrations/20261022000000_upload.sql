-- Upload connector: a user uploads a CSV for a source of kind 'upload'. The file is kept as is
-- on object storage with one documents row; each row goes through the same ingest path as a
-- push message. The column mapping lives on the source (sources.config.mapping).
insert into public.engine_settings (key, value, description) values
  ('upload.max_bytes',   '5242880', 'Largest file accepted by the upload connector (bytes)'),
  ('upload.max_rows',    '5000',    'Most data rows accepted in one uploaded file'),
  ('upload.files_per_day', '50',    'Uploads accepted per source in 24 hours')
on conflict (key) do nothing;

-- The same file uploaded twice to one source is refused (sha256 of the bytes).
create unique index documents_source_sha on public.documents (source_id, sha256) where source_id is not null;
create index documents_tenant_created on public.documents (tenant_id, created_at desc);
