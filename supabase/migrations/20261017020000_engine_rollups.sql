create table public.engine_jobs (
  name text primary key,
  watermark timestamptz,
  last_run timestamptz,
  last_ok timestamptz,
  last_error text,
  last_duration_ms integer,
  last_result jsonb
);
alter table public.engine_jobs enable row level security;
create policy engine_jobs_admin on public.engine_jobs for select using (public.is_platform_admin());

create or replace function public.rollup_metrics(p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  lookback interval := make_interval(mins => coalesce((public.engine_setting('rollup.lookback_min') #>> '{}')::integer, 60));
  wm timestamptz;
  t_from timestamptz;
  t_to timestamptz := date_bin('5 minutes', p_now, 'epoch');
  h_to timestamptz := date_trunc('hour', p_now, 'UTC');
  n5 integer;
  n60 integer;
begin
  insert into public.engine_jobs (name) values ('rollup') on conflict do nothing;
  select watermark into wm from public.engine_jobs where name = 'rollup' for update;
  t_from := coalesce(wm - lookback, (select date_bin('5 minutes', min(ts), 'epoch') from public.metrics));
  if t_from is null or t_from >= t_to then
    return jsonb_build_object('from', t_from, 'to', t_to, 'rollups_5m', 0, 'rollups_1h', 0);
  end if;

  insert into public.metric_rollups (tenant_id, object_id, metric_id, res, bucket, min, max, avg, count)
  select tenant_id, object_id, metric_id, 300, date_bin('5 minutes', ts, 'epoch'),
         min(value), max(value), avg(value), count(*)
  from public.metrics where ts >= t_from and ts < t_to
  group by 1, 2, 3, 5
  on conflict (object_id, metric_id, res, bucket) do update
    set min = excluded.min, max = excluded.max, avg = excluded.avg, count = excluded.count;
  get diagnostics n5 = row_count;

  insert into public.metric_rollups (tenant_id, object_id, metric_id, res, bucket, min, max, avg, count)
  select tenant_id, object_id, metric_id, 3600, date_trunc('hour', bucket, 'UTC'),
         min(min), max(max), sum(avg * count) / sum(count), sum(count)
  from public.metric_rollups
  where res = 300 and bucket >= date_trunc('hour', t_from, 'UTC') and bucket < h_to
  group by 1, 2, 3, 5
  on conflict (object_id, metric_id, res, bucket) do update
    set min = excluded.min, max = excluded.max, avg = excluded.avg, count = excluded.count;
  get diagnostics n60 = row_count;

  update public.engine_jobs set watermark = greatest(coalesce(wm, t_to), t_to) where name = 'rollup';
  return jsonb_build_object('from', t_from, 'to', t_to, 'rollups_5m', n5, 'rollups_1h', n60);
end;
$$;

create or replace function public.apply_retention(p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  raw_days integer := (public.engine_setting('retention.raw_days') #>> '{}')::integer;
  d5 integer := (public.engine_setting('retention.rollup_5m_days') #>> '{}')::integer;
  d60 integer := (public.engine_setting('retention.rollup_1h_days') #>> '{}')::integer;
  lookback interval := make_interval(mins => coalesce((public.engine_setting('rollup.lookback_min') #>> '{}')::integer, 60));
  covered timestamptz := (select watermark - lookback from public.engine_jobs where name = 'rollup');
  cutoff timestamptz;
  part record;
  dropped integer := 0;
  n_default integer := 0;
  n5 integer := 0;
  n60 integer := 0;
begin
  if raw_days is not null then
    cutoff := least(p_now - make_interval(days => raw_days), coalesce(covered, '-infinity'));
    for part in
      select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'public.metrics'::regclass and c.relname ~ '^metrics_\d{8}$'
    loop
      if (to_date(substr(part.relname, 9), 'YYYYMMDD') + 1)::timestamp at time zone 'utc' <= cutoff then
        execute format('drop table public.%I', part.relname);
        dropped := dropped + 1;
      end if;
    end loop;
    delete from public.metrics_default where ts < cutoff;
    get diagnostics n_default = row_count;
  end if;
  if d5 is not null then
    delete from public.metric_rollups where res = 300 and bucket < p_now - make_interval(days => d5);
    get diagnostics n5 = row_count;
  end if;
  if d60 is not null then
    delete from public.metric_rollups where res = 3600 and bucket < p_now - make_interval(days => d60);
    get diagnostics n60 = row_count;
  end if;
  return jsonb_build_object('partitions_dropped', dropped, 'default_rows', n_default,
                            'rollups_5m', n5, 'rollups_1h', n60);
end;
$$;

create or replace function public.engine_maintenance(p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  started timestamptz := clock_timestamp();
  result jsonb;
begin
  insert into public.engine_jobs (name) values ('maintenance') on conflict do nothing;
  begin
    result := jsonb_build_object(
      'rollup', public.rollup_metrics(p_now),
      'retention', public.apply_retention(p_now),
      'partitions_created', public.ensure_metric_partitions());
    update public.engine_jobs set last_run = started, last_ok = started, last_error = null,
      last_duration_ms = extract(epoch from clock_timestamp() - started) * 1000, last_result = result
    where name = 'maintenance';
  exception when others then
    update public.engine_jobs set last_run = started, last_error = sqlerrm,
      last_duration_ms = extract(epoch from clock_timestamp() - started) * 1000
    where name = 'maintenance';
    result := jsonb_build_object('error', sqlerrm);
  end;
  return result;
end;
$$;

create or replace function public.engine_schedule() returns boolean language plpgsql as $$
declare
  every integer := coalesce((public.engine_setting('rollup.interval_min') #>> '{}')::integer, 15);
  spec text := case when every < 60 then format('*/%s * * * *', every)
                    else format('0 */%s * * *', greatest(every / 60, 1)) end;
begin
  if to_regnamespace('cron') is null then return false; end if;
  perform cron.schedule('vdx-engine-maintenance', spec, 'select public.engine_maintenance()');
  return true;
end;
$$;

revoke execute on function public.rollup_metrics(timestamptz), public.apply_retention(timestamptz),
  public.engine_maintenance(timestamptz), public.engine_schedule() from public, anon, authenticated;

do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron not available (%), maintenance must be scheduled externally', sqlerrm;
end;
$$;
select public.engine_schedule();
