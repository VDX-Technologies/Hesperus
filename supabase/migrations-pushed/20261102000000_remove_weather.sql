-- Remove the retired weather warnings feature and its scheduled job.
delete from public.engine_jobs where name = 'weather';
drop table if exists public.weather_notification_outbox cascade;
drop table if exists public.weather_notification_subscriptions cascade;
drop table if exists public.weather_alerts cascade;
drop table if exists public.weather_source_cache cascade;
drop table if exists public.weather_locations cascade;
