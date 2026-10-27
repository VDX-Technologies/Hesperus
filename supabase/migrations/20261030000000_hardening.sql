-- Close public RPC access to platform settings and enforce member roles for alert acknowledgements.
revoke execute on function public.engine_setting(text) from public, anon, authenticated;
grant execute on function public.engine_setting(text) to service_role;

create or replace function public.ack_alert(alert_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  t uuid;
  obj uuid;
begin
  select tenant_id, object_id into t, obj
    from public.object_alerts where id = alert_id;

  if t is null or not (
    public.is_platform_admin()
    or public.org_role(t) in ('owner', 'member')
  ) then
    raise exception 'alert not found';
  end if;

  update public.object_alerts
     set status = 'acknowledged', acked_at = now(), acked_by = auth.uid()
   where id = alert_id and status = 'open';

  if found then
    insert into public.audit_log (tenant_id, actor, actor_label, action, object_id, data)
    values (t, auth.uid(), (select email from auth.users where id = auth.uid()), 'alert.ack', obj,
            jsonb_build_object('alert_id', alert_id));
    return true;
  end if;
  return false;
end;
$$;
revoke execute on function public.ack_alert(bigint) from public, anon;
grant execute on function public.ack_alert(bigint) to authenticated;

-- Tie uploaded metrics to their source document so an atomic reprocess/delete removes them too.
alter table public.metrics
  add column document_id uuid references public.documents (id) on delete cascade;
create index metrics_document_id on public.metrics (document_id) where document_id is not null;

-- Preserve escalation and reopen notifications as distinct deliveries for each recipient.
alter table public.weather_alerts
  add column notification_revision integer not null default 1 check (notification_revision > 0);
alter table public.weather_notification_outbox
  add column notification_revision integer not null default 1 check (notification_revision > 0);
alter table public.weather_notification_outbox
  drop constraint weather_notification_outbox_alert_id_recipient_user_id_key;
alter table public.weather_notification_outbox
  add constraint weather_notification_outbox_alert_recipient_revision_key
  unique (alert_id, recipient_user_id, notification_revision);
