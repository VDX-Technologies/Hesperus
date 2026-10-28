alter table public.events add column idempotency_key text;

create unique index events_source_idempotency
  on public.events (tenant_id, source_id, idempotency_key)
  where idempotency_key is not null;

create index event_objects_tenant_object_event
  on public.event_objects (tenant_id, object_id, event_id);
