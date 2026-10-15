-- Owners tune their own alarm thresholds (org_modules.config), but only VDX turns products on
-- or off. RLS works per row, so the column split uses column privileges: signed-in users may
-- update only the "config" column; the vendor console changes "enabled" with the service role.
revoke update on public.org_modules from authenticated;
grant update (config) on public.org_modules to authenticated;

create policy "owners tune modules" on public.org_modules for update
  using (public.can_manage(org_id)) with check (public.can_manage(org_id));

-- Device-level overrides live in devices.config: owners can already update their devices.
