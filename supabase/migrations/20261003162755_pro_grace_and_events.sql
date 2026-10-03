-- Cancelled or past-due subscriptions keep Pro until the end of the period they paid for.
create or replace function public.is_pro(uid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = uid and s.plan = 'pro'
      and (
        (s.status in ('active', 'trialing') and (s.current_period_end is null or s.current_period_end > now()))
        or (s.status in ('canceled', 'past_due') and s.current_period_end > now())
      )
  );
$$;

-- When the last payment event was applied, so an older event delivered late can't undo a newer one.
alter table public.subscriptions add column if not exists event_at timestamptz;
