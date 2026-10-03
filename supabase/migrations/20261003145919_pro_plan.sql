-- Pro plan. Rows are written only by the payment webhook (service role) or by hand for now.
create table public.subscriptions (
  user_id                  uuid primary key references auth.users (id) on delete cascade,
  plan                     text not null default 'free' check (plan in ('free', 'pro')),
  status                   text not null default 'active' check (status in ('active', 'trialing', 'past_due', 'canceled')),
  provider                 text,          -- 'dodo' later; 'manual' for hand-granted Pro
  provider_customer_id     text,
  provider_subscription_id text,
  current_period_end       timestamptz,   -- null = no end (manual grants)
  updated_at               timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;
create policy "read own subscription" on public.subscriptions for select to authenticated using (user_id = (select auth.uid()));

-- Hosted voice usage per user per month. Written only by Edge Functions (service role).
create table public.usage (
  user_id    uuid not null references auth.users (id) on delete cascade,
  month      date not null,               -- first day of the month (UTC)
  lines      int  not null default 0,
  chars      int  not null default 0,
  summaries  int  not null default 0,
  fallbacks  int  not null default 0,     -- Smallest busy/failed, OpenAI TTS used instead
  primary key (user_id, month)
);
alter table public.usage enable row level security;
revoke all on public.usage from anon, authenticated;

create or replace function public.is_pro(uid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = uid and s.plan = 'pro' and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
  );
$$;
revoke execute on function public.is_pro(uuid) from public, anon, authenticated;

-- What the app shows under General → Account.
create or replace function public.my_plan()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'plan', case when public.is_pro(auth.uid()) then 'pro' else 'free' end,
    'period_end', (select current_period_end from public.subscriptions where user_id = auth.uid()),
    'lines_used', coalesce((select lines from public.usage where user_id = auth.uid() and month = date_trunc('month', now() at time zone 'utc')::date), 0),
    'lines_cap', 3000
  );
$$;
revoke execute on function public.my_plan() from public, anon;
grant execute on function public.my_plan() to authenticated;

-- Called by Edge Functions after a hosted line or summary. Returns the new monthly line count.
create or replace function public.record_usage(uid uuid, p_lines int, p_chars int, p_summaries int, p_fallbacks int)
returns int
language sql volatile security definer set search_path = ''
as $$
  insert into public.usage as u (user_id, month, lines, chars, summaries, fallbacks)
  values (uid, date_trunc('month', now() at time zone 'utc')::date, p_lines, p_chars, p_summaries, p_fallbacks)
  on conflict (user_id, month) do update set
    lines = u.lines + excluded.lines, chars = u.chars + excluded.chars,
    summaries = u.summaries + excluded.summaries, fallbacks = u.fallbacks + excluded.fallbacks
  returning lines;
$$;
revoke execute on function public.record_usage(uuid, int, int, int, int) from public, anon, authenticated;
