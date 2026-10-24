-- VDX Terra becomes a console like the others: the organizations that exist keep it, new ones get
-- it unless VDX chooses otherwise from the vendor console.
update public.organizations set consoles = array_prepend('terra', consoles) where not ('terra' = any (consoles));
alter table public.organizations alter column consoles set default '{terra}';
