-- Signed firmware. sha256 replaces md5 as the hash the nodes check (md5 stays for nodes that only
-- know it). signature is an Ed25519 signature, made offline with scripts/sign-firmware.ts, over
--   "vdx-firmware-v1\n<version>\n<sha256 hex>"
-- so a binary cannot be swapped in the store, nor relabelled as another version. The server checks
-- it against FIRMWARE_PUBLIC_KEY on upload; the node checks it against the same key in its own
-- image before switching OTA slot. Releases uploaded before this have neither.
alter table public.firmware_releases
  add column sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  add column signature text check (signature ~ '^[A-Za-z0-9+/]{86}==$');
