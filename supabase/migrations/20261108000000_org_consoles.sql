alter table public.organizations add column if not exists consoles text[] not null default '{}';
