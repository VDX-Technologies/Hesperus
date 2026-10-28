alter table public.firmware_releases
  add column sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  add column signature text check (signature ~ '^[A-Za-z0-9+/]{86}==$');
