-- The objects of an event keep the order they were given in: the first is the one the event is
-- about (a run's project, a comment's result), the rest are what it also touches. Rows written
-- before this keep 0 and fall back to the object id.
alter table public.event_objects add column pos smallint not null default 0;
