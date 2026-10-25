-- Web push (PWA) alarm notifications: one row per browser/device subscribed to an organization.
-- Written by the app server after checking membership; a subscription the push service reports
-- as gone (404/410) is deleted by the sender.
create table public.push_subscriptions (
  tenant_id uuid not null references public.organizations (id) on delete cascade,
  endpoint text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  locale text not null default 'it' check (locale in ('it', 'en')),
  user_agent text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, endpoint)
);
create index push_subscriptions_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
create policy push_subscriptions_read on public.push_subscriptions for select
  using (user_id = auth.uid() and public.can_read(tenant_id));
