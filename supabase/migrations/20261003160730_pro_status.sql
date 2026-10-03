-- One call for the hosted functions, made with the user's own JWT (verified by PostgREST, no extra
-- round trip to the auth server): who is calling, are they Pro, and how many lines this month.
create or replace function public.pro_status()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'uid', auth.uid(),
    'pro', public.is_pro(auth.uid()),
    'lines', coalesce((select lines from public.usage where user_id = auth.uid() and month = date_trunc('month', now() at time zone 'utc')::date), 0)
  );
$$;
revoke execute on function public.pro_status() from public, anon;
grant execute on function public.pro_status() to authenticated;
