update public.organizations set consoles = array_prepend('terra', consoles) where not ('terra' = any (consoles));
alter table public.organizations alter column consoles set default '{terra}';
