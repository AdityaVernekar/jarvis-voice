alter table public.pings
  add column user_id uuid references auth.users (id) on delete set null,
  add column features jsonb not null default '{}';

create index pings_user_id_idx on public.pings (user_id);

-- The app's only way in. user_id comes from the caller's JWT, never from the payload.
create function public.ping(p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if octet_length(p::text) > 4000
     or length(p->>'app_version') > 20
     or length(p->>'macos_version') > 20
     or length(p->>'arch') > 10
     or length(p->>'locale') > 20
     or jsonb_typeof(coalesce(p->'agents', '[]')) <> 'array'
     or jsonb_array_length(coalesce(p->'agents', '[]')) > 10
     or jsonb_typeof(coalesce(p->'features', '{}')) <> 'object'
     or p->>'app_version' is null then
    raise exception 'bad ping' using errcode = '22023';
  end if;

  insert into public.pings as t (install_id, app_version, macos_version, arch, locale, agents, features, user_id)
  values (
    (p->>'install_id')::uuid,
    p->>'app_version',
    p->>'macos_version',
    p->>'arch',
    p->>'locale',
    array(select jsonb_array_elements_text(coalesce(p->'agents', '[]'))),
    coalesce(p->'features', '{}'),
    auth.uid()
  )
  on conflict (install_id, day) do update set
    app_version   = excluded.app_version,
    macos_version = excluded.macos_version,
    arch          = excluded.arch,
    locale        = excluded.locale,
    agents        = excluded.agents,
    features      = excluded.features,
    user_id       = coalesce(excluded.user_id, t.user_id),
    created_at    = now();
end;
$$;

revoke insert on public.pings from anon;
drop policy "app can insert today's ping" on public.pings;
revoke execute on function public.ping(jsonb) from public;
grant execute on function public.ping(jsonb) to anon, authenticated;
