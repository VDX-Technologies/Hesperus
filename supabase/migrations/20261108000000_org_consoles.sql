-- The consoles an organization's users see besides VDX Terra, which every organization has (it
-- holds the schema editor, the activity and the consent the others link to). VDX turns them on
-- from the vendor console: like products, customers read them and only platform admins change
-- them, which the existing "admins manage orgs" policy already enforces.
alter table public.organizations add column if not exists consoles text[] not null default '{}';
