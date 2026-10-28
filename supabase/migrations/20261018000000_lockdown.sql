do $$
declare p regclass;
begin
  for p in select inhrelid::regclass from pg_inherits where inhparent = 'public.metrics'::regclass loop
    execute format('alter table %s enable row level security', p);
    execute format('revoke all on %s from anon, authenticated', p);
  end loop;
end;
$$;

create or replace function public.ensure_metric_partitions(days_ahead integer default null)
returns integer language plpgsql as $$
declare
  ahead integer := coalesce(days_ahead, (public.engine_setting('metrics.partitions_ahead_days'))::integer, 3);
  d date;
  name text;
  created integer := 0;
begin
  for d in select generate_series((now() at time zone 'utc')::date,
                                  (now() at time zone 'utc')::date + ahead, '1 day')::date loop
    name := 'metrics_' || to_char(d, 'YYYYMMDD');
    continue when to_regclass('public.' || name) is not null;
    continue when exists (select 1 from public.metrics_default
                          where ts >= d::timestamp at time zone 'utc'
                            and ts < (d + 1)::timestamp at time zone 'utc');
    execute format(
      'create table public.%I partition of public.metrics for values from (%L) to (%L)',
      name, d::timestamp at time zone 'utc', (d + 1)::timestamp at time zone 'utc');
    execute format('alter table public.%I enable row level security', name);
    execute format('revoke all on public.%I from anon, authenticated', name);
    created := created + 1;
  end loop;
  return created;
end;
$$;

alter publication supabase_realtime drop table public.devices, public.alerts;
alter publication supabase_realtime add table public.objects, public.object_alerts;

drop table public.readings, public.alerts, public.gateways, public.devices;
