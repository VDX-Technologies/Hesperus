revoke update on public.org_modules from authenticated;
grant update (config) on public.org_modules to authenticated;

create policy "owners tune modules" on public.org_modules for update
  using (public.can_manage(org_id)) with check (public.can_manage(org_id));

